/* global document */

import ProxyAdapterDom from './proxy-adapter-dom';

// Svelte Native support
// =====================
//
// Rerendering Svelte Native page proves challenging...
//
// In NativeScript, pages are the top level component. They are normally
// introduced into NativeScript's runtime by its `navigate` function. This
// is how Svelte Natives handles it: it renders the Page component to a
// dummy fragment, and "navigate" to the page element thus created.
//
// As long as modifications only impact child components of the page, then
// we can keep the existing page and replace its content for HMR.
//
// However, if the page component itself is modified (including its system
// title bar), things get hairy...
//
// Apparently, the sole way of introducing a new page in a NS application is
// to navigate to it (no way to just replace it in its parent "element", for
// example). This is how it is done in NS's own "core" HMR.
//
// Unfortunately the API they're using to do that is not public... Its various
// parts remain exposed though (but documented as private), so this exploratory
// work now relies on it. It might be fragile...
//
// The problem is that there is no public API that can navigate to a page and
// replacing (like location.replace) the current history entry. Actually there
// is an active issue at NS asking for that. Incidentally, members of
// NativeScript-Vue have commented on the issue to weight in for it -- they
// probably face some similar challenge.

// svelte-native uses navigateFrom event + e.isBackNavigation to know
// when to $destroy the component -- but we don't want our proxy instance
// destroyed when we renavigate to the same page for navigation purposes!
const interceptPageNavigation = pageElement => {
  const originalNativeView = pageElement.nativeView;
  const { on } = originalNativeView;
  const ownOn = originalNativeView.hasOwnProperty('on');
  // tricks svelte-native into giving us its handler
  originalNativeView.on = function(type, handler, ...rest) {
    if (type === 'navigatedFrom') {
      this.navigatedFromHandler = handler;
      if (ownOn) {
        originalNativeView.on = on;
      } else {
        delete originalNativeView.on;
      }
    } else {
      throw new Error(
        'Unexpected call: has underlying svelte-native code changed?'
      );
    }
  };
};

export default class ProxyAdapterNative extends ProxyAdapterDom {
  constructor(instance) {
    super(instance);

    this.nativePageElement = null;
    this.originalNativeView = null;
    this.navigatedFromHandler = null;

    this.relayNativeNavigatedFrom = this.relayNativeNavigatedFrom.bind(this);
  }

  afterMount(target, anchor) {
    // nativePageElement needs to be updated each time (only for page
    // components, native component that are not pages follow normal flow)
    //
    // DEBUG quid of components that are initially a page, but then have the
    // <page> tag removed while running? or the opposite?
    //
    // insertionPoint needs to be updated _only when the target changes_ --
    // i.e. when the component is mount, i.e. (in svelte3) when the component
    // is _created_, and svelte3 doesn't allow it to move afterward -- that
    // is, insertionPoint only needs to be created once when the component is
    // first mounted.
    //
    // DEBUG is it really true that components' elements cannot move in the
    // DOM? what about keyed list?
    //
    const isNativePage = target.tagName === 'fragment';
    if (isNativePage) {
      const nativePageElement = target.firstChild;
      interceptPageNavigation(nativePageElement);
      this.nativePageElement = nativePageElement;
    } else {
      // try to protect against components changing from page to no-page
      // or vice versa -- see DEBUG 1 above. NOT TESTED so prolly not working
      this.nativePageElement = null;
      super.afterMount(target, anchor);
    }
  }

  destroyComponent(removeInsertionPoint) {
    super.destroyComponent(removeInsertionPoint);
    if (removeInsertionPoint) {
      if (this.nativePageElement) {
        // native cleaning will happen when navigating back from the page
        this.nativePageElement = null;
      }
    }
  }

  rerender() {
    const {
      cmp,
      nativePageElement,
      instance: { debugName },
    } = this;
    if (!cmp) {
      const msg = 'Trying to rerender an already destroyed native component?';
      console.warn(msg, debugName);
      return;
    }
    if (nativePageElement) {
      this.rerenderNativePage();
    } else {
      super.rerender();
    }
  }

  rerenderNativePage() {
    const { nativePageElement: oldPageElement } = this;
    const nativeView = oldPageElement.nativeView;
    const frame = nativeView.frame || nativeView._modalParent;
    if (!frame) {
      // wtf? hopefully a race condition with a destroyed component, so
      // we have nothing more to do here
      //
      // for once, it happens when hot reloading dev deps, like this file
      //

      return;
    }
    const isCurrentPage = frame.currentPage === oldPageElement.nativeView;
    // console.log('rerender native page, current:', isCurrentPage);
    if (isCurrentPage) {
      const newPageElement = this.createPage();

      if (frame.canGoBack()) {
        // copied from TNS FrameBase.replacePage
        //
        // it is not public but there is a comment in there indicating
        // it is for HMR (probably their own core HMR though)
        //
        // frame.navigationType = NavigationType.replace;
        const currentBackstackEntry = frame._currentEntry;
        frame.navigationType = 2;
        frame.performNavigation({
          isBackNavigation: false,
          entry: {
            resolvedPage: newPageElement.nativeView,
            //
            // entry: currentBackstackEntry.entry,
            entry: Object.assign(currentBackstackEntry.entry, {
              animated: false,
            }),
            navDepth: currentBackstackEntry.navDepth,
            fragmentTag: currentBackstackEntry.fragmentTag,
            frameId: currentBackstackEntry.frameId,
          },
        });
      } else {
        // The "replacePage" strategy does not work on the first page
        // of the stack.
        //
        // Resulting bug:
        // - launch
        // - change first page => HMR
        // - navigate to other page
        // - back
        //   => actual: back to OS
        //   => expected: back to page 1
        //
        // Fortunately, we can overwrite history in this case.
        //
        const nativeView = newPageElement.nativeView;
        frame.navigate({
          // animated: false,
          create: () => nativeView,
          clearHistory: true,
        });
      }
    } else {
      const backEntry = frame.backStack.find(
        ({ resolvedPage: page }) => page === oldPageElement.nativeView
      );
      if (!backEntry) {
        // well... looks like we didn't make it to history after all
        return;
      }
      // replace existing nativeView
      const newPageElement = this.createPage();
      backEntry.resolvedPage = newPageElement.nativeView;
    }
  }

  createPage() {
    const { nativePageElement, relayNativeNavigatedFrom } = this;
    const oldNativeView = nativePageElement.nativeView;
    // cleanup
    // we want nativePageElement to be null for createComponent -> afterMount
    // to update it
    const removeInsertionPoint = true;
    this.destroyComponent(removeInsertionPoint);
    // rerender
    const target = document.createElement('fragment');
    this.createComponent(target, null);
    this.afterMount(target); // udpates nativePageElement
    const newPageElement = this.nativePageElement;
    // update event proxy
    oldNativeView.off('navigatedFrom', relayNativeNavigatedFrom);
    nativePageElement.nativeView.on('navigatedFrom', relayNativeNavigatedFrom);
    return newPageElement;
  }

  relayNativeNavigatedFrom({ isBackNavigation }) {
    const { originalNativeView, navigatedFromHandler } = this;
    if (!isBackNavigation) {
      return;
    }
    if (originalNativeView) {
      const { off } = originalNativeView;
      const ownOff = originalNativeView.hasOwnProperty('off');
      originalNativeView.off = function() {
        this.navigatedFromHandler = null;
        if (ownOff) {
          originalNativeView.off = off;
        } else {
          delete originalNativeView.off;
        }
      };
    }
    if (navigatedFromHandler) {
      return navigatedFromHandler.apply(this, arguments);
    }
  }
}
