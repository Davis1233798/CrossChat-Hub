import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { configureBrokerStudy } = createRequire(import.meta.url)('../desktop/native-broker-study.cjs');

test('native broker inactive flag performs no profile or app operations', () => {
  const previous = process.env.CROSSCHAT_BROKER_STUDY;
  try {
    delete process.env.CROSSCHAT_BROKER_STUDY;
    const untouched = new Proxy({}, { get() { throw new Error('Normal startup touched study app state'); } });
    assert.equal(configureBrokerStudy(untouched), null);
  } finally {
    if (previous === undefined) delete process.env.CROSSCHAT_BROKER_STUDY;
    else process.env.CROSSCHAT_BROKER_STUDY = previous;
  }
});

test('packaged broker flag refuses before reading or changing profile paths', () => {
  const previous = process.env.CROSSCHAT_BROKER_STUDY;
  try {
    process.env.CROSSCHAT_BROKER_STUDY = '1';
    const guarded = new Proxy({ isPackaged: true }, { get(target, key) {
      if (key !== 'isPackaged') throw new Error('Rejected study accessed app paths');
      return target[key];
    } });
    assert.throws(() => configureBrokerStudy(guarded), /requires unpackaged Windows/);
  } finally {
    if (previous === undefined) delete process.env.CROSSCHAT_BROKER_STUDY;
    else process.env.CROSSCHAT_BROKER_STUDY = previous;
  }
});
