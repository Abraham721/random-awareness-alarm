// store.js — tiny JSON-file persistence (fine for a class-sized user base).
'use strict';
const fs = require('fs');

class Store {
  constructor(file) {
    this.file = file;
    this.data = { users: {} };
    this._timer = null;
    this._load();
  }
  _load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.data || typeof this.data !== 'object') this.data = { users: {} };
      if (!this.data.users) this.data.users = {};
    } catch (_) {
      this.data = { users: {} };
    }
  }
  // Debounced async save to avoid hammering disk.
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, 200);
  }
  saveNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('store save error:', e.message);
    }
  }
  getUser(id) { return this.data.users[id]; }
  upsertUser(id, patch) {
    const u = this.data.users[id] || { id, createdAt: Date.now() };
    Object.assign(u, patch, { updatedAt: Date.now() });
    this.data.users[id] = u;
    this.save();
    return u;
  }
  deleteUser(id) { delete this.data.users[id]; this.save(); }
  allUsers() { return Object.values(this.data.users); }
}

module.exports = Store;
