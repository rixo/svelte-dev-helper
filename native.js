// Native needs a separate entry points because it imports modules from
// NativeScript's packages.
//
// Those packages won't be available in a non-native project. But webpack will
// eagerly try to parse all import/require in a bundle, even those that may
// never be called.
//
import { initProxy } from './lib/proxy';
import AdapterNative from './lib/native/proxy-adapter-native';
import { patchShowModal } from './lib/native/patch-page-show-modal';

if (module.hot) {
  patchShowModal();
}

export const createProxy = initProxy(AdapterNative);
