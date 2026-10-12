/**
 * Unified Event Stream — WebSocket broadcaster for AEE envelopes
 *
 * Manages connected WebSocket clients and broadcasts AEE envelopes
 * from all sources (chat, bastion, fleet, workflow) in real-time.
 * Supports per-client filtering by layer and entity.
 *
 * Created: CLI-2d (Stream CLI Phase 2)
 */

class EventStreamHub {
  constructor() {
    /** @type {Map<WebSocket, {layers?: string[], entity?: string}>} */
    this._clients = new Map();
    this._broadcastCount = 0;
  }

  /**
   * Register a WebSocket client with optional filters.
   * @param {WebSocket} ws - WebSocket connection
   * @param {{layers?: string[], entity?: string}} filters - Optional filters
   */
  addClient(ws, filters = {}) {
    this._clients.set(ws, filters);
  }

  /**
   * Remove a WebSocket client.
   * @param {WebSocket} ws
   */
  removeClient(ws) {
    this._clients.delete(ws);
  }

  /**
   * Number of connected clients.
   * @returns {number}
   */
  clientCount() {
    return this._clients.size;
  }

  /**
   * Broadcast an AEE envelope to all matching clients.
   * Clients with closed connections or send errors are auto-removed.
   * @param {Object} envelope - AEE v1 envelope
   */
  broadcast(envelope) {
    this._broadcastCount++;
    const json = JSON.stringify(envelope);

    for (const [ws, filters] of this._clients) {
      // Skip closed connections
      if (ws.readyState !== 1) continue;

      // Apply layer filter
      if (filters.layers && filters.layers.length > 0) {
        const intent = envelope.intent || '';
        const matchesLayer = filters.layers.some(layer => intent.startsWith(layer + '.'));
        if (!matchesLayer) continue;
      }

      // Apply entity filter
      if (filters.entity) {
        if (!this._matchesEntity(envelope, filters.entity)) continue;
      }

      // Send (fire-and-forget per client)
      try {
        ws.send(json);
      } catch {
        this._clients.delete(ws);
      }
    }
  }

  /**
   * Check if an envelope mentions a specific entity.
   * Searches payload.details.targets, payload.host_id, and from/to fields.
   * @param {Object} envelope
   * @param {string} entity
   * @returns {boolean}
   */
  _matchesEntity(envelope, entity) {
    const str = JSON.stringify(envelope);
    return str.includes(entity);
  }

  /**
   * Get hub statistics.
   * @returns {{clients: number, broadcasts: number}}
   */
  stats() {
    return {
      clients: this._clients.size,
      broadcasts: this._broadcastCount,
    };
  }
}

module.exports = { EventStreamHub };
