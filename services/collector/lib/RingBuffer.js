/**
 * RingBuffer - Fixed-capacity circular buffer for PTY output
 *
 * Stores the most recent N bytes of terminal output. When the buffer
 * is full, oldest data is overwritten. Used to replay scrollback
 * on session reconnect.
 */

class RingBuffer {
  /**
   * @param {number} capacity - Maximum bytes to store (default 51200 = 50KB)
   */
  constructor(capacity = 51200) {
    this._capacity = capacity;
    this._buf = Buffer.alloc(capacity);
    this._head = 0;   // Next write position
    this._size = 0;   // Bytes currently stored
  }

  /**
   * Append a string to the buffer
   * @param {string} data - Terminal output data
   */
  write(data) {
    if (!data || data.length === 0) return;

    const bytes = Buffer.from(data, 'utf8');

    if (bytes.length >= this._capacity) {
      // Data larger than buffer — keep only the tail
      bytes.copy(this._buf, 0, bytes.length - this._capacity);
      this._head = 0;
      this._size = this._capacity;
      return;
    }

    const spaceAtEnd = this._capacity - this._head;

    if (bytes.length <= spaceAtEnd) {
      // Fits without wrapping
      bytes.copy(this._buf, this._head);
      this._head += bytes.length;
      if (this._head >= this._capacity) this._head = 0;
    } else {
      // Wraps around
      bytes.copy(this._buf, this._head, 0, spaceAtEnd);
      bytes.copy(this._buf, 0, spaceAtEnd);
      this._head = bytes.length - spaceAtEnd;
    }

    this._size = Math.min(this._size + bytes.length, this._capacity);
  }

  /**
   * Read all buffered data in order (oldest to newest)
   * @returns {string}
   */
  read() {
    if (this._size === 0) return '';

    if (this._size < this._capacity) {
      // Buffer hasn't wrapped yet — data starts at 0
      return this._buf.toString('utf8', 0, this._size);
    }

    // Buffer is full and has wrapped — oldest data starts at _head
    const part1 = this._buf.toString('utf8', this._head, this._capacity);
    const part2 = this._buf.toString('utf8', 0, this._head);
    return part1 + part2;
  }

  /**
   * Number of bytes currently stored
   * @returns {number}
   */
  get length() {
    return this._size;
  }

  /**
   * Maximum capacity in bytes
   * @returns {number}
   */
  get capacity() {
    return this._capacity;
  }

  /**
   * Clear the buffer
   */
  clear() {
    this._head = 0;
    this._size = 0;
  }
}

module.exports = RingBuffer;
