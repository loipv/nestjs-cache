import 'reflect-metadata';
import { Injectable, Scope } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineOf, injectEngine } from '../../../src/decorators/inject-engine.js';
import { CACHE_ENGINE, CACHE_ENGINE_PROPERTY } from '../../../src/module/tokens.js';

const fakeEngine = { tag: 'engine' };

@Injectable()
class Plain {}
injectEngine(Plain.prototype);

@Injectable({ scope: Scope.REQUEST })
class RequestScoped {}
injectEngine(RequestScoped.prototype);

@Injectable()
class Child extends Plain {}

@Injectable()
class Twice {}

describe('injectEngine', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        { provide: CACHE_ENGINE, useValue: fakeEngine },
        Plain,
        RequestScoped,
        Child,
        Twice,
      ],
    }).compile();
  });

  it('injects into a default-scoped provider', () => {
    expect(engineOf(moduleRef.get(Plain))).toBe(fakeEngine);
  });

  it('injects into a request-scoped provider', async () => {
    expect(engineOf(await moduleRef.resolve(RequestScoped))).toBe(fakeEngine);
  });

  it('injects into a subclass instance', () => {
    expect(engineOf(moduleRef.get(Child))).toBe(fakeEngine);
  });

  it('is safe to call twice on one prototype', async () => {
    injectEngine(Twice.prototype);
    injectEngine(Twice.prototype);
    const fresh = await Test.createTestingModule({
      providers: [{ provide: CACHE_ENGINE, useValue: fakeEngine }, Twice],
    }).compile();
    expect(engineOf(fresh.get(Twice))).toBe(fakeEngine);
  });

  it('keeps the property out of enumeration and JSON', () => {
    const instance = moduleRef.get(Plain);
    expect(Object.keys(instance)).not.toContain(String(CACHE_ENGINE_PROPERTY));
    expect(JSON.stringify(instance)).toBe('{}');
  });

  it('returns undefined outside DI and for non-objects', () => {
    expect(engineOf(new Plain())).toBeUndefined();
    expect(engineOf(undefined)).toBeUndefined();
    expect(engineOf(null)).toBeUndefined();
  });

  it('fails module compilation when no engine provider exists', async () => {
    await expect(Test.createTestingModule({ providers: [Plain] }).compile()).rejects.toThrow();
  });
});
