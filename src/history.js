// Session-local, document-scoped history. Source IDs, extraction and reading
// progress are deliberately outside transactions and are never rolled back.
const snapshot = doc => structuredClone({ notes: doc.notes, translations: doc.translations });
export class History {
  undoStack = [];
  redoStack = [];
  constructor(limit = 60) { this.limit = limit; }
  record(doc, label, change) {
    const before = snapshot(doc);
    try { change(); } catch (error) { Object.assign(doc, before); throw error; }
    const after = snapshot(doc);
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    this.undoStack.push({ before, after, label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }
  undo(doc) { const entry = this.undoStack.pop(); if (!entry) return null; Object.assign(doc, structuredClone(entry.before)); this.redoStack.push(entry); return entry.label; }
  redo(doc) { const entry = this.redoStack.pop(); if (!entry) return null; Object.assign(doc, structuredClone(entry.after)); this.undoStack.push(entry); return entry.label; }
}
