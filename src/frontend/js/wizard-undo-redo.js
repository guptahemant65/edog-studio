/**
 * UndoRedoManager — Undo/redo stack for DAG canvas operations.
 *
 * Command pattern: each undoable action pushes a command with do/undo functions.
 * Integrates with WizardEventBus for event-driven state sync.
 * Stack cap: 50 entries (drops oldest when exceeded).
 *
 * @author Pixel — EDOG Studio hivemind
 */

class UndoRedoManager {
  /**
   * @param {object} options
   * @param {object} options.eventBus — WizardEventBus instance
   * @param {number} [options.maxStack] — max undo stack size (default: 50)
   * @param {string} [options.undoEvent] — event name for undo (default: 'undo:performed')
   * @param {string} [options.redoEvent] — event name for redo (default: 'redo:performed')
   */
  constructor(options) {
    var opts = options || {};
    this._undoStack = [];
    this._redoStack = [];
    this._maxStack = opts.maxStack || 50;
    this._eventBus = opts.eventBus || null;
    this._undoEvent = opts.undoEvent || 'undo:performed';
    this._redoEvent = opts.redoEvent || 'redo:performed';
  }

  /**
   * Push a new undoable command.
   * Clears redo stack. Enforces max stack size.
   * @param {object} command
   * @param {string} command.type — e.g. 'add-node', 'remove-node', 'move-node'
   * @param {string} command.description — human-readable, e.g. "Add node 'orders'"
   * @param {Function} command.doFn — called on redo
   * @param {Function} command.undoFn — called on undo
   * @param {boolean} [command.redoOnPush] — if true, call doFn when pushing (default: false)
   */
  push(command) {
    if (!this._undoStack) { return; }

    var entry = {
      type: command.type,
      description: command.description,
      doFn: command.doFn,
      undoFn: command.undoFn,
      timestamp: Date.now()
    };

    this._redoStack.length = 0;
    this._undoStack.push(entry);

    if (this._undoStack.length > this._maxStack) {
      this._undoStack.shift();
    }

    if (command.redoOnPush) {
      try {
        entry.doFn();
      } catch (err) {
        console.error('[UndoRedoManager] doFn threw on push: ' + err);
      }
    }
  }

  /**
   * Undo the most recent command.
   * @returns {boolean} — true if undo was performed
   */
  undo() {
    if (!this._undoStack) { return false; }
    if (this._undoStack.length === 0) { return false; }

    var cmd = this._undoStack.pop();
    this._redoStack.push(cmd);

    try {
      cmd.undoFn();
    } catch (err) {
      console.error('[UndoRedoManager] undoFn threw: ' + err);
    }

    if (this._eventBus) {
      this._eventBus.emit(this._undoEvent, {
        type: cmd.type,
        description: cmd.description
      });
    }

    return true;
  }

  /**
   * Redo the most recently undone command.
   * @returns {boolean} — true if redo was performed
   */
  redo() {
    if (!this._redoStack) { return false; }
    if (this._redoStack.length === 0) { return false; }

    var cmd = this._redoStack.pop();
    this._undoStack.push(cmd);

    try {
      cmd.doFn();
    } catch (err) {
      console.error('[UndoRedoManager] doFn threw: ' + err);
    }

    if (this._eventBus) {
      this._eventBus.emit(this._redoEvent, {
        type: cmd.type,
        description: cmd.description
      });
    }

    return true;
  }

  /**
   * Check if undo is available.
   * @returns {boolean}
   */
  canUndo() {
    return !!(this._undoStack && this._undoStack.length > 0);
  }

  /**
   * Check if redo is available.
   * @returns {boolean}
   */
  canRedo() {
    return !!(this._redoStack && this._redoStack.length > 0);
  }

  /**
   * Get the description of the next undo action.
   * @returns {string|null}
   */
  undoDescription() {
    if (!this._undoStack || this._undoStack.length === 0) { return null; }
    return this._undoStack[this._undoStack.length - 1].description;
  }

  /**
   * Get the description of the next redo action.
   * @returns {string|null}
   */
  redoDescription() {
    if (!this._redoStack || this._redoStack.length === 0) { return null; }
    return this._redoStack[this._redoStack.length - 1].description;
  }

  /**
   * Clear both stacks.
   */
  clear() {
    if (this._undoStack) { this._undoStack.length = 0; }
    if (this._redoStack) { this._redoStack.length = 0; }
  }

  /**
   * Destroy — clear stacks and null out references.
   */
  destroy() {
    this.clear();
    this._undoStack = null;
    this._redoStack = null;
    this._eventBus = null;
  }

  /**
   * Get current stack sizes for debugging.
   * @returns {{ undoSize: number, redoSize: number }}
   */
  stackInfo() {
    return {
      undoSize: this._undoStack ? this._undoStack.length : 0,
      redoSize: this._redoStack ? this._redoStack.length : 0
    };
  }
}

window.UndoRedoManager = UndoRedoManager;
