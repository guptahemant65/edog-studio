/**
 * Unit tests for WizardEventBus.
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

const WizardEventBus = window.WizardEventBus;

describe('WizardEventBus', () => {

  test('constructor creates clean instance', () => {
    const bus = new WizardEventBus();
    assert.ok(bus);
    assert.equal(bus.listenerCount('anything'), 0);
  });

  test('on() registers listener and returns unsubscribe function', () => {
    const bus = new WizardEventBus();
    const unsub = bus.on('test', () => {});
    assert.equal(typeof unsub, 'function');
    assert.equal(bus.listenerCount('test'), 1);
  });

  test('emit() calls registered handlers with data', () => {
    const bus = new WizardEventBus();
    let received = null;
    bus.on('evt', (data) => { received = data; });
    bus.emit('evt', { value: 42 });
    assert.deepEqual(received, { value: 42 });
  });

  test('emit() calls multiple handlers for same event', () => {
    const bus = new WizardEventBus();
    const calls = [];
    bus.on('evt', () => calls.push('a'));
    bus.on('evt', () => calls.push('b'));
    bus.emit('evt');
    assert.deepEqual(calls, ['a', 'b']);
  });

  test('emit() does nothing for unregistered events', () => {
    const bus = new WizardEventBus();
    // Should not throw
    bus.emit('no-such-event', { x: 1 });
  });

  test('unsubscribe function removes only that handler', () => {
    const bus = new WizardEventBus();
    const calls = [];
    const unsub = bus.on('evt', () => calls.push('a'));
    bus.on('evt', () => calls.push('b'));
    assert.equal(bus.listenerCount('evt'), 2);

    unsub();
    assert.equal(bus.listenerCount('evt'), 1);

    bus.emit('evt');
    assert.deepEqual(calls, ['b']);
  });

  test('off() removes specific handler', () => {
    const bus = new WizardEventBus();
    const handler = () => {};
    bus.on('evt', handler);
    assert.equal(bus.listenerCount('evt'), 1);
    bus.off('evt', handler);
    assert.equal(bus.listenerCount('evt'), 0);
  });

  test('off() on last handler cleans up event key', () => {
    const bus = new WizardEventBus();
    const handler = () => {};
    bus.on('evt', handler);
    bus.off('evt', handler);
    // listenerCount returns 0, internal list deleted
    assert.equal(bus.listenerCount('evt'), 0);
  });

  test('destroy() clears all listeners', () => {
    const bus = new WizardEventBus();
    bus.on('a', () => {});
    bus.on('b', () => {});
    bus.destroy();
    assert.equal(bus.listenerCount('a'), 0);
    assert.equal(bus.listenerCount('b'), 0);
  });

  test('emit() after destroy() does nothing (no throw)', () => {
    const bus = new WizardEventBus();
    bus.on('evt', () => { throw new Error('should not run'); });
    bus.destroy();
    bus.emit('evt', 'data');
  });

  test('on() after destroy() does nothing (no throw)', () => {
    const bus = new WizardEventBus();
    bus.destroy();
    const unsub = bus.on('evt', () => {});
    assert.equal(typeof unsub, 'function');
    assert.equal(bus.listenerCount('evt'), 0);
    // Calling returned unsub should also not throw
    unsub();
  });

  test('listenerCount() returns correct count', () => {
    const bus = new WizardEventBus();
    assert.equal(bus.listenerCount('x'), 0);
    bus.on('x', () => {});
    assert.equal(bus.listenerCount('x'), 1);
    bus.on('x', () => {});
    assert.equal(bus.listenerCount('x'), 2);
    bus.on('y', () => {});
    assert.equal(bus.listenerCount('x'), 2);
    assert.equal(bus.listenerCount('y'), 1);
  });

  test('listenerCount() returns 0 after destroy', () => {
    const bus = new WizardEventBus();
    bus.on('x', () => {});
    bus.destroy();
    assert.equal(bus.listenerCount('x'), 0);
  });

  test('handlers receive correct data argument', () => {
    const bus = new WizardEventBus();
    let got;
    bus.on('data-test', (d) => { got = d; });

    bus.emit('data-test', 'string-val');
    assert.equal(got, 'string-val');

    bus.emit('data-test', 123);
    assert.equal(got, 123);

    bus.emit('data-test', null);
    assert.equal(got, null);

    const obj = { nested: { a: 1 } };
    bus.emit('data-test', obj);
    assert.equal(got, obj);
  });

  test('handlers called in registration order', () => {
    const bus = new WizardEventBus();
    const order = [];
    bus.on('seq', () => order.push(1));
    bus.on('seq', () => order.push(2));
    bus.on('seq', () => order.push(3));
    bus.emit('seq');
    assert.deepEqual(order, [1, 2, 3]);
  });

  test('removing handler during emit does not crash', () => {
    const bus = new WizardEventBus();
    const calls = [];
    let unsub2;
    bus.on('evt', () => {
      calls.push('a');
      // Remove handler b during emission
      unsub2();
    });
    unsub2 = bus.on('evt', () => calls.push('b'));
    bus.on('evt', () => calls.push('c'));

    // Because emit() snapshots the array, handler b still fires this round
    bus.emit('evt');
    assert.ok(calls.includes('a'));
    assert.ok(calls.includes('c'));
    // b was in the snapshot so it fires too
    assert.ok(calls.includes('b'));

    // After the emit, b is unsubscribed
    calls.length = 0;
    bus.emit('evt');
    assert.deepEqual(calls, ['a', 'c']);
  });

  test('unsubscribe is idempotent (double-call safe)', () => {
    const bus = new WizardEventBus();
    const unsub = bus.on('evt', () => {});
    unsub();
    unsub(); // second call should not throw or remove other handlers
    assert.equal(bus.listenerCount('evt'), 0);
  });

  test('handler errors are swallowed and do not block other handlers', () => {
    const bus = new WizardEventBus();
    const calls = [];
    bus.on('evt', () => { throw new Error('boom'); });
    bus.on('evt', () => calls.push('ok'));
    bus.emit('evt');
    assert.deepEqual(calls, ['ok']);
  });
});
