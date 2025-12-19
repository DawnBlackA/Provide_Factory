/**
 * EIP-1193 Provider factory: createEip1193Provider(cfg)
 * - Use config object cfg to create and (optionally) inject window.ethereum
 * - Spec alignment (comments mark corresponding EIP clauses/conventions):
 *   * EIP-1193: request({method, params}), events (accountsChanged/chainChanged), error shape {code,message,data?}
 *   * Compatibility: enable, send, sendAsync, window.web3.currentProvider
 *   * EIP-6963: multi-wallet discovery (announceProvider / requestProvider)
 *   * Non-EIP but common convention: ethereum#initialized initialization event
 *
 * cfg (optional fields, pass as needed):
 * {
 *   name: 'My Flutter Wallet',          // EIP-6963 info.name
 *   icon: 'data:image/png;base64,...',  // EIP-6963 info.icon (https URL or base64)
 *   rdns: 'app.myflutter.wallet',       // EIP-6963 info.rdns (reverse-DNS, unique id)
 *   bridgeName: 'ethereum',             // Must match Flutter addJavaScriptHandler name
 *   initialSelectedAddress: '0x...',    // Initial address (optional)
 *   initialChainId: '0x1',              // Initial chain ID (hex string)
 *   autoInject: true,                   // Inject into window.ethereum (default true)
 *   forceReplace: false,                // Replace existing window.ethereum if present (default false)
 *   enableLegacyWeb3: true,             // Set window.web3.currentProvider (default true)
 *   enableEip6963: true,                // Enable EIP-6963 (default true)
 * }
 */

function createEip1193Provider(cfg = {}) {
  // ========= EIP-1193: Provider is an event emitter =========
  class Emitter {
    constructor() { this._m = {}; }
    on(event, handler) {
      (this._m[event] ||= new Set()).add(handler);
      return this;
    }
    removeListener(event, handler) {
      this._m[event]?.delete(handler);
      return this;
    }
    emit(event, ...args) {
      this._m[event]?.forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } });
    }
  }

  const emitter = new Emitter();

  // ========= Provider public state (common convention for dApps) =========
  let _selectedAddress = cfg.initialSelectedAddress ?? null; // '0x...' or null
  let _chainId = cfg.initialChainId ?? null;                 // '0x1' or null

  // ========= Bridge to host (Flutter): implementation detail, not part of EIP-1193 =========
  const BRIDGE = cfg.bridgeName || 'ethereum';

  const callHost = (payload) => {
    // payload: { id, method, params }
    if (!window.flutter_inappwebview?.callHandler) {
      const err = new Error('Bridge not available');
      err.code = -32603; // EIP-1193 error format: internal error (fallback)
      return Promise.reject(err);
    }
    return window.flutter_inappwebview
      .callHandler(BRIDGE, JSON.stringify(payload))
      .then((raw) => {
        // Flutter should return {"result": any} or {"error": {code, message, data?}}
        const resp = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!resp) return null;
        if (resp.error) {
          // ========= EIP-1193: standardized error object =========
          const e = new Error(resp.error.message || 'Provider error');
          e.code = resp.error.code ?? -32603;
          if (resp.error.data !== undefined) e.data = resp.error.data;
          throw e;
        }
        return resp.result;
      });
  };

  const genId = () => Math.floor(Math.random() * 1e9);

  // ========= EIP-1193: Provider core interface =========
  const provider = {
    // Identifiers (do not impersonate other wallets; some dApps use these)
    isMetaMask: false,
    isStatus: false,
    isCoinbaseWallet: false,
    isMyWallet: true, // Custom flag

    // Convenience read-only properties (convention; not required by EIP-1193)
    get selectedAddress() { return _selectedAddress; },
    get chainId() { return _chainId; },

    /**
     * EIP-1193: request({ method, params }) -> Promise<any>
     * - dApps use this for JSON-RPC / wallet_* methods
     * - Promise resolve: result; reject: { code, message, data? } error
     */
    request: ({ method, params } = {}) => {
      const id = genId();
      return callHost({ id, method, params }).then((result) => {
        // ========= EIP-1193: state changes -> emit events =========
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          if (Array.isArray(result)) {
            const next = result[0] || null;
            const changed = (next || '').toLowerCase() !== (_selectedAddress || '').toLowerCase();
            _selectedAddress = next;
            if (changed) emitter.emit('accountsChanged', _selectedAddress ? [_selectedAddress] : []);
          }
        } else if (method === 'eth_chainId') {
          if (typeof result === 'string') {
            const changed = result !== _chainId;
            _chainId = result;
            if (changed) emitter.emit('chainChanged', _chainId);
          }
        }
        return result;
      });
    },

    /**
     * EIP-1193: event API
     * - Required: accountsChanged / chainChanged
     * - Optional: connect / disconnect / message (use _emitFromHost if you push from host)
     */
    on: (event, handler) => { emitter.on(event, handler); return provider; },
    removeListener: (event, handler) => { emitter.removeListener(event, handler); return provider; },

    /**
     * Compatibility layer (widely used though not required by EIPs)
     * - enable(): legacy EIP-1102 flow, equivalent to eth_requestAccounts
     * - send / sendAsync: legacy paths used by web3.js/ethers v5
     */
    enable: () => provider.request({ method: 'eth_requestAccounts' }),

    send: (methodOrPayload, paramsOrCallback) => {
      if (typeof methodOrPayload === 'string') {
        return provider.request({ method: methodOrPayload, params: paramsOrCallback });
      }
      const payload = methodOrPayload; // { id, jsonrpc, method, params }
      const cb = typeof paramsOrCallback === 'function' ? paramsOrCallback : undefined;
      const p = callHost({ id: payload.id ?? genId(), method: payload.method, params: payload.params })
        .then((result) => ({ id: payload.id, jsonrpc: '2.0', result }))
        .catch((err) => ({ id: payload.id, jsonrpc: '2.0', error: { code: err.code ?? -32603, message: err.message, data: err.data } }));
      if (cb) { p.then(r => cb(null, r)).catch(e => cb(e, null)); return; }
      return p;
    },

    sendAsync: (payload, cb) => {
      const p = callHost({ id: payload.id ?? genId(), method: payload.method, params: payload.params })
        .then((result) => ({ id: payload.id, jsonrpc: '2.0', result }))
        .catch((err) => ({ id: payload.id, jsonrpc: '2.0', error: { code: err.code ?? -32603, message: err.message, data: err.data } }));
      p.then(r => cb(null, r)).catch(e => cb(e, null));
    },

    /**
     * Non-standard: host (Flutter) pushes events to dApp (EIP-1193 expects events on state changes)
     * - Call this after native account/chain changes to sync
     */
    _emitFromHost: (event, payload) => {
      if (event === 'accountsChanged') {
        const next = (payload && payload[0]) || null;
        const changed = (next || '').toLowerCase() !== (_selectedAddress || '').toLowerCase();
        _selectedAddress = next;
        if (changed) emitter.emit('accountsChanged', _selectedAddress ? [_selectedAddress] : []);
      } else if (event === 'chainChanged') {
        const changed = payload !== _chainId;
        _chainId = payload;
        if (changed) emitter.emit('chainChanged', _chainId);
      } else {
        emitter.emit(event, payload); // connect/disconnect/message (as needed)
      }
    },
  };

  // ========= Legacy ecosystem compatibility (strongly recommended) =========
  if (cfg.enableLegacyWeb3 !== false) {
    window.web3 = { currentProvider: provider };
  }
  provider.providers = [provider]; // often used for multi-wallet detection

  // ========= EIP-6963: multi-wallet discovery (strongly recommended) =========
  if (cfg.enableEip6963 !== false) {
    try {
      const info = {
        uuid: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()),
        name: cfg.name || 'My Flutter Wallet',
        icon: cfg.icon || 'data:image/svg+xml;base64,', // replace with your logo
        rdns: cfg.rdns || 'app.myflutter.wallet',
      };
      const announce = () => {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
          detail: { info, provider },
        }));
      };
      window.addEventListener('eip6963:requestProvider', announce);
      announce(); // proactively announce once so connectors discover immediately
    } catch (_) {}
  }

  // ========= Inject into window.ethereum (industry convention) =========
  const shouldInject = cfg.autoInject !== false;
  const hasExisting = !!window.ethereum;

  if (shouldInject && (!hasExisting || cfg.forceReplace)) {
    Object.defineProperty(window, 'ethereum', { value: provider, configurable: !!cfg.forceReplace });
    // Initialization event (MetaMask convention; many dApps listen)
    try { window.dispatchEvent(new Event('ethereum#initialized')); } catch (_) {}
  }

  return provider;
}