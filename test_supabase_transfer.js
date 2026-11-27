/**
 * E2E Verification Script: test_supabase_transfer.js
 * 
 * Demonstrates the Comet Browser MCP Server CDP patterns:
 * 1. Attaches to your active, logged-in Supabase dashboard tab.
 * 2. Clicks on the first available project.
 * 3. Navigates to Project Settings -> General.
 * 4. Scrolls down and clicks the "Transfer Project" button.
 * 5. Captures the resulting confirmation modal, reads its text, and takes a screenshot.
 * 
 * Running instructions:
 * 1. Ensure Comet is running with: --remote-debugging-port=9224
 * 2. Open https://supabase.com/dashboard and log in.
 * 3. Run: node test_supabase_transfer.js
 */

import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CDP_PORT = 9224;
const CDP_HOST = '127.0.0.1';

function log(...args) {
  console.log(`[Test-Supabase]`, ...args);
}

async function discoverTabs() {
  return new Promise((resolve, reject) => {
    const url = `http://${CDP_HOST}:${CDP_PORT}/json`;
    http.get(url, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(JSON.parse(data));
      });
    }).on('error', reject);
  });
}

// --- Stateful CDP Connection ---
class TestCdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pendingRequests = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', async () => {
        try {
          await this.send('Page.enable');
          await this.send('Runtime.enable');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const { resolve, reject } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg.result || {});
          }
        }
      });
      this.ws.on('error', reject);
      this.ws.on('close', () => {
        this.cleanup(new Error('WebSocket closed'));
      });
    });
  }

  cleanup(err) {
    for (const [_, { reject }] of this.pendingRequests.entries()) {
      reject(err);
    }
    this.pendingRequests.clear();
  }

  async send(method, params = {}) {
    this.msgId++;
    const id = this.msgId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  async close() {
    if (this.ws) this.ws.close();
  }

  // Evaluate JS and get value
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Exception: ${res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result.value;
  }

  // High-performance React-safe page locator and synthetic click
  async click(selector, description = '') {
    log(`Clicking: "${description || selector}"`);
    
    // Page-side resolver and click coordinates finder
    const pageResolver = `
      (function(sel) {
        function getVisibleText(el) {
          return (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
        }
        function isVisible(el) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        let el = document.querySelector(sel);
        if (!el) {
          // Substring text search fallback
          const all = document.querySelectorAll('button, a, span, p, div');
          const selLower = sel.toLowerCase();
          for (const item of all) {
            if (isVisible(item) && getVisibleText(item).toLowerCase().includes(selLower)) {
              el = item;
              break;
            }
          }
        }
        if (!el || !isVisible(el)) return null;

        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          tagName: el.tagName.toLowerCase(),
          text: getVisibleText(el).slice(0, 40)
        };
      })(${JSON.stringify(selector)})
    `;

    let coords = null;
    let retries = 15; // Wait up to 3 seconds for SPA elements to mount/render
    while (retries > 0) {
      coords = await this.eval(pageResolver);
      if (coords) break;
      retries--;
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (!coords) {
      throw new Error(`Could not find or click element: "${selector}"`);
    }

    // Dispatch native click events
    const { x, y, tagName, text } = coords;
    log(`Found <${tagName}> "${text}" at coordinate (${Math.round(x)}, ${Math.round(y)})`);
    
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    
    // Wait briefly for click handler animation/render
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}

// --- Main Test runner ---
async function runTest() {
  log('Starting Supabase project-transfer E2E test...');
  
  let tabs = [];
  try {
    tabs = await discoverTabs();
  } catch (e) {
    console.error(`\n❌ Error: Comet browser is not reachable on port ${CDP_PORT}.`);
    console.error('Make sure you run Perplexity Comet with: --remote-debugging-port=9224');
    process.exit(1);
  }

  const supabaseTab = tabs.find(t => t.url.includes('supabase.com/dashboard') && t.type === 'page');
  if (!supabaseTab) {
    console.error('\n❌ Error: No open tab found for supabase.com/dashboard.');
    console.error('Please open Comet, navigate to https://supabase.com/dashboard, and log in first.');
    process.exit(1);
  }

  log(`Found active Supabase tab: "${supabaseTab.title}"`);
  log(`Connecting to CDP WebSocket...`);
  
  const client = new TestCdpClient(supabaseTab.webSocketDebuggerUrl);
  await client.connect();
  log('Connected!');

  try {
    // 1. We are on the Supabase Dashboard page. Let's find the first project card and click it.
    log('Waiting for projects list...');
    await client.click('a[href^="/project/"]', 'First Project Card');
    
    // Wait for the project dashboard to render
    log('Waiting for project page to load...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 2. Click on Settings link in navigation (usually a sidebar menu option with Settings text or settings path)
    log('Navigating to settings...');
    // We target links ending with /settings/general or sidebar items containing "Settings"
    await client.click('a[href$="/settings/general"]', 'Project General Settings Link');
    
    // Wait for Settings to load
    log('Waiting for Settings page...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 3. Scroll down and click the "Transfer Project" button
    log('Locating "Transfer Project" button...');
    await client.click('Transfer project', 'Transfer Project button');

    // Wait for modal to pop up and animate
    log('Waiting for Transfer Project modal to appear...');
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 4. Capture modal text and print it out to verify
    log('Reading modal contents...');
    const modalText = await client.eval(`
      (function() {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, div'));
        let modal = null;
        for (const h of headings) {
          if (h.innerText && h.innerText.includes('Transfer project')) {
            // Find parent modal
            let parent = h.parentElement;
            while (parent && parent !== document.body) {
              if (parent.getAttribute('role') === 'dialog' || parent.className.includes('modal') || parent.className.includes('Dialog')) {
                modal = parent;
                break;
              }
              parent = parent.parentElement;
            }
            if (modal) break;
            // Fallback to the heading itself if no dialog parent
            modal = h;
          }
        }
        if (!modal) {
          // General fallback
          const dialog = document.querySelector('[role="dialog"]');
          if (dialog) return dialog.innerText;
          return 'Modal container not found, reading full viewport text: \\n' + document.body.innerText.slice(0, 1000);
        }
        return modal.innerText;
      })()
    `);

    console.log('\n==================================================');
    console.log('🎉 SUCCESS! Captured Transfer Project Modal Text:');
    console.log('==================================================');
    console.log(modalText);
    console.log('==================================================\n');

    // 5. Take screenshot of the modal and save it
    log('Capturing screenshot of the modal...');
    const screenshotRes = await client.send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.resolve('supabase_transfer_modal.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotRes.data, 'base64'));
    
    log(`📷 Screenshot successfully saved to disk at: ${screenshotPath}`);
    log('E2E Verification completed successfully!');

  } catch (err) {
    console.error('\n❌ Error during execution:', err.message);
  } finally {
    await client.close();
  }
}

runTest();
