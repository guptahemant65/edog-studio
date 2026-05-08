/**
 * Unit tests for UndoRedoManager.
 * @author Sentinel — EDOG Studio hivemind
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// Minimal browser-like globals for the source files
var window = {};
var document = { createElement: function() { return { style: {}, classList: { add: function(){}, remove: function(){} }, setAttribute: function(){}, appendChild: function(){}, addEventListener: function(){} }; }, createElementNS: function() { return { style: {}, classList: { add: function(){}, remove: function(){} }, setAttribute: function(){}, setAttributeNS: function(){}, appendChild: function(){}, addEventListener: function(){} }; }, querySelector: function() { return null; }, body: { appendChild: function(){} } };

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function loadSource(filename) {
  var code = readFileSync(join(srcDir, filename), 'utf-8');
  var ctx = vm.createContext({ window: window, document: document, console: console, setTimeout: setTimeout, setInterval: setInterval, clearInterval: clearInterval, Object: Object, Array: Array, Math: Math, Date: Date, Error: Error, JSON: JSON, parseInt: parseInt, parseFloat: parseFloat });
  vm.runInContext(code, ctx);
  Object.assign(window, ctx.window);
}

loadSource('wizard-event-bus.js');
loadSource('wizard-undo-redo.js');

const WizardEventBus = window.WizardEventBus;
const UndoRedoManager = window.UndoRedoManager;

/** Helper: create a simple trackable command */
function makeCommand(label) {
  const log = [];
  return {
    log,
    command: {
      type: 'test',
      description: label || 'test-cmd',
      doFn: () => log.push('do'),
      undoFn: () => log.push('undo'),
    },
  };
}

describe('UndoRedoManager', () => {

  test('constructor creates empty stacks', () => {
    const mgr = new UndoRedoManager();
    const info = mgr.stackInfo();
    assert.equal(info.undoSize, 0);
    assert.equal(info.redoSize, 0);
  });

  test('push() adds command to undo stack', () => {
    const mgr = new UndoRedoManager();
    const { command } = makeCommand();
    mgr.push(command);
    assert.equal(mgr.stackInfo().undoSize, 1);
  });

  test('push() clears redo stack', () => {
    const mgr = new UndoRedoManager();
    const { command: c1 } = makeCommand('c1');
    const { command: c2 } = makeCommand('c2');
    mgr.push(c1);
    mgr.undo();
    assert.equal(mgr.stackInfo().redoSize, 1);

    mgr.push(c2);
    assert.equal(mgr.stackInfo().redoSize, 0);
  });

  test('undo() calls command.undoFn()', () => {
    const mgr = new UndoRedoManager();
    const { command, log } = makeCommand();
    mgr.push(command);
    mgr.undo();
    assert.ok(log.includes('undo'));
  });

  test('undo() moves command to redo stack', () => {
    const mgr = new UndoRedoManager();
    mgr.push(makeCommand().command);
    mgr.undo();
    assert.equal(mgr.stackInfo().undoSize, 0);
    assert.equal(mgr.stackInfo().redoSize, 1);
  });

  test('undo() on empty stack does nothing', () => {
    const mgr = new UndoRedoManager();
    const result = mgr.undo();
    assert.equal(result, false);
  });

  test('redo() calls command.doFn()', () => {
    const mgr = new UndoRedoManager();
    const { command, log } = makeCommand();
    mgr.push(command);
    mgr.undo();
    log.length = 0;
    mgr.redo();
    assert.ok(log.includes('do'));
  });

  test('redo() moves command back to undo stack', () => {
    const mgr = new UndoRedoManager();
    mgr.push(makeCommand().command);
    mgr.undo();
    mgr.redo();
    assert.equal(mgr.stackInfo().undoSize, 1);
    assert.equal(mgr.stackInfo().redoSize, 0);
  });

  test('redo() on empty stack does nothing', () => {
    const mgr = new UndoRedoManager();
    const result = mgr.redo();
    assert.equal(result, false);
  });

  test('stack limit: pushing beyond max drops oldest', () => {
    const mgr = new UndoRedoManager({ maxStack: 3 });
    mgr.push(makeCommand('a').command);
    mgr.push(makeCommand('b').command);
    mgr.push(makeCommand('c').command);
    assert.equal(mgr.stackInfo().undoSize, 3);

    mgr.push(makeCommand('d').command);
    assert.equal(mgr.stackInfo().undoSize, 3);
    // Oldest ('a') was dropped; top is 'd'
    assert.equal(mgr.undoDescription(), 'd');
  });

  test('canUndo() returns correct boolean', () => {
    const mgr = new UndoRedoManager();
    assert.equal(mgr.canUndo(), false);
    mgr.push(makeCommand().command);
    assert.equal(mgr.canUndo(), true);
    mgr.undo();
    assert.equal(mgr.canUndo(), false);
  });

  test('canRedo() returns correct boolean', () => {
    const mgr = new UndoRedoManager();
    assert.equal(mgr.canRedo(), false);
    mgr.push(makeCommand().command);
    assert.equal(mgr.canRedo(), false);
    mgr.undo();
    assert.equal(mgr.canRedo(), true);
    mgr.redo();
    assert.equal(mgr.canRedo(), false);
  });

  test('clear() empties both stacks', () => {
    const mgr = new UndoRedoManager();
    mgr.push(makeCommand().command);
    mgr.push(makeCommand().command);
    mgr.undo();
    assert.ok(mgr.stackInfo().undoSize > 0);
    assert.ok(mgr.stackInfo().redoSize > 0);

    mgr.clear();
    assert.equal(mgr.stackInfo().undoSize, 0);
    assert.equal(mgr.stackInfo().redoSize, 0);
  });

  test('stackInfo() tracks sizes correctly', () => {
    const mgr = new UndoRedoManager();
    let info = mgr.stackInfo();
    assert.equal(info.undoSize, 0);
    assert.equal(info.redoSize, 0);
    mgr.push(makeCommand().command);
    mgr.push(makeCommand().command);
    info = mgr.stackInfo();
    assert.equal(info.undoSize, 2);
    assert.equal(info.redoSize, 0);
    mgr.undo();
    info = mgr.stackInfo();
    assert.equal(info.undoSize, 1);
    assert.equal(info.redoSize, 1);
  });

  test('undo emits event via eventBus if provided', () => {
    const bus = new WizardEventBus();
    const mgr = new UndoRedoManager({ eventBus: bus });
    let emitted = null;
    bus.on('undo:performed', (data) => { emitted = data; });

    mgr.push(makeCommand('move-node').command);
    mgr.undo();

    assert.ok(emitted);
    assert.equal(emitted.type, 'test');
    assert.equal(emitted.description, 'move-node');
  });

  test('redo emits event via eventBus if provided', () => {
    const bus = new WizardEventBus();
    const mgr = new UndoRedoManager({ eventBus: bus });
    let emitted = null;
    bus.on('redo:performed', (data) => { emitted = data; });

    mgr.push(makeCommand('add-node').command);
    mgr.undo();
    mgr.redo();

    assert.ok(emitted);
    assert.equal(emitted.type, 'test');
    assert.equal(emitted.description, 'add-node');
  });

  test('works without eventBus (null)', () => {
    const mgr = new UndoRedoManager();
    const { command, log } = makeCommand();
    mgr.push(command);
    mgr.undo();
    mgr.redo();
    assert.deepEqual(log, ['undo', 'do']);
  });

  test('destroy() clears stacks and refs', () => {
    const bus = new WizardEventBus();
    const mgr = new UndoRedoManager({ eventBus: bus });
    mgr.push(makeCommand().command);
    mgr.destroy();

    assert.equal(mgr.canUndo(), false);
    assert.equal(mgr.canRedo(), false);
    const info = mgr.stackInfo();
    assert.equal(info.undoSize, 0);
    assert.equal(info.redoSize, 0);
    // push after destroy should not throw
    mgr.push(makeCommand().command);
  });

  test('custom event names are respected', () => {
    const bus = new WizardEventBus();
    const mgr = new UndoRedoManager({
      eventBus: bus,
      undoEvent: 'custom:undo',
      redoEvent: 'custom:redo',
    });
    const events = [];
    bus.on('custom:undo', () => events.push('undo'));
    bus.on('custom:redo', () => events.push('redo'));

    mgr.push(makeCommand().command);
    mgr.undo();
    mgr.redo();
    assert.deepEqual(events, ['undo', 'redo']);
  });

  test('redoOnPush calls doFn immediately', () => {
    const mgr = new UndoRedoManager();
    const log = [];
    mgr.push({
      type: 'test',
      description: 'immediate',
      doFn: () => log.push('do'),
      undoFn: () => log.push('undo'),
      redoOnPush: true,
    });
    assert.deepEqual(log, ['do']);
  });
});
