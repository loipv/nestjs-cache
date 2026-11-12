import { describe, expect, it } from 'vitest';
import { FakeTracer } from './fake-tracer.js';

describe('FakeTracer', () => {
  it('parents spans through the active span; root and startSpan do not activate', async () => {
    const tracer = new FakeTracer();
    await tracer.startActiveSpan('outer', {}, async (outer) => {
      await Promise.resolve();
      tracer.startSpan('inactive').end();
      tracer.startActiveSpan('root', { root: true }, (root) => {
        root.end();
      });
      outer.end();
    });
    const [outer, inactive, root] = tracer.spans();
    expect(inactive!.parent).toBe(outer);
    expect(root!.parent).toBeUndefined();
    expect(root!.root).toBe(true);
    expect(root!.traceId).not.toBe(outer!.traceId);
    expect(inactive!.traceId).toBe(outer!.traceId);
    expect(tracer.spans('root')).toEqual([root]);
    tracer.assertAllEnded();
  });

  it('assertAllEnded fails on a span never ended or ended twice', () => {
    const tracer = new FakeTracer();
    const span = tracer.startSpan('a');
    expect(() => {
      tracer.assertAllEnded();
    }).toThrow('spans not ended exactly once: a (0)');
    span.end();
    span.end();
    expect(() => {
      tracer.assertAllEnded();
    }).toThrow('spans not ended exactly once: a (2)');
  });

  it('assertAllEnded fails on a write after end, which is dropped', () => {
    const tracer = new FakeTracer();
    const span = tracer.startSpan('a', { attributes: { x: 1 } });
    span.end();
    span.setAttribute('y', 2);
    span.addEvent('e');
    span.recordException(new Error('late'));
    span.setStatus({ code: 2 });
    const recorded = tracer.span('a');
    expect(recorded.attributes).toEqual({ x: 1 });
    expect(recorded.events).toEqual([]);
    expect(recorded.exceptions).toEqual([]);
    expect(recorded.status).toBeUndefined();
    expect(recorded.writesAfterEnd).toEqual([
      'setAttribute',
      'addEvent',
      'recordException',
      'setStatus',
    ]);
    expect(() => {
      tracer.assertAllEnded();
    }).toThrow('spans written after end: a (setAttribute, addEvent, recordException, setStatus)');
  });

  it('failOn throws before or after the work, until reset', () => {
    const tracer = new FakeTracer();
    tracer.failOn('startActiveSpan');
    let called = false;
    expect(() => {
      tracer.startActiveSpan('x', {}, () => {
        called = true;
      });
    }).toThrow('fake tracer: startActiveSpan failed');
    expect(called).toBe(false);
    tracer.failOn('startActiveSpan', 'after');
    expect(() => {
      tracer.startActiveSpan('x', {}, (span) => {
        called = true;
        span.end();
      });
    }).toThrow('fake tracer: startActiveSpan failed');
    expect(called).toBe(true);
    tracer.reset();
    tracer.startActiveSpan('y', {}, (span) => {
      span.end();
    });
    expect(tracer.spans().map((s) => s.name)).toEqual(['x', 'y']);
    expect(tracer.calls).toBe(5);
    tracer.assertAllEnded();
  });

  it('span(name) requires exactly one match', () => {
    const tracer = new FakeTracer();
    expect(() => tracer.span('a')).toThrow('expected one span "a", found 0');
  });
});
