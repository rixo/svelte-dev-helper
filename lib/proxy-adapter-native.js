/* global document */

import DomAdapter from './proxy-adapter-dom';

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

// pageRenavigate: see discussion above.
//
// When `false`, there won't be a renavigation when the current Page
// component is updated, preventing history mess & unwanted transition
// anim. Changes to the page itself (e.g. title) won't be reflected by
// HMR though, only its child components will be updated.
//
// UPDATE I've finally found how to renavigate to the same page without
// messing the history stack. Apparently it is used by NS's own HMR, although
// it is documented as private. This solution is clearly better for the user,
// so this option will probably vanish soon. (And I hope NS will expose a
// public solution soon.)
//
const pageRenavigate = true;

export default options => {
  const { debugName } = options;

  const domAdapter = DomAdapter(Object.assign({}, options, {
    afterMount,
  }));

  const {
    getComponent,
    createComponent,
    afterMount: _afterMount,
    destroyComponent: _destroyComponent,
    rerender: _rerender,
  } = domAdapter;

  let nativePageElement;
  // This is the only view that is known by svelte-native. It will put
  // a navigatedFrom listener on it, and destroy the instance (i.e. our
  // proxy instance) in it.
  let originalNativeView;
  let navigatedFromHandler;

  // svelte-native uses navigateFrom event + e.isBackNavigation to know
  // when to $destroy the component -- but we don't want our proxy instance
  // destroyed when we renavigate to the same page for navigation purposes!
  const interceptPageNavigation = pageElement => {
    originalNativeView = pageElement.nativeView;
    const { on } = originalNativeView;
    const ownOn = originalNativeView.hasOwnProperty('on');
    // tricks svelte-native into giving us its handler
    originalNativeView.on = function(type, handler, ...rest) {
      if (type === 'navigatedFrom') {
        navigatedFromHandler = handler;
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

  function afterMount(target, anchor) {
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
      nativePageElement = target.firstChild;
      interceptPageNavigation(nativePageElement);
    } else {
      _afterMount(target, anchor);
      // try to protect against components changing from page to no-page
      // or vice versa -- see DEBUG 1 above. NOT TESTED so prolly not working
      nativePageElement = null;
    }
  }

  function destroyComponent(removeInsertionPoint) {
    _destroyComponent(removeInsertionPoint);
    if (removeInsertionPoint) {
      if (nativePageElement) {
        // native cleaning will happen when navigating back from the page
        nativePageElement = null;
      }
    }
  }

  const rerender = () => {
    if (!getComponent()) {
      const msg = 'Trying to rerender an already destroyed native component?';
      console.warn(msg, debugName);
      return;
    }
    if (nativePageElement) {
      rerenderNativePage();
    } else {
      _rerender();
    }
  };

  const relayNativeNavigatedFrom = function({ isBackNavigation }) {
    if (!isBackNavigation) {
      return;
    }
    if (originalNativeView) {
      const { off } = originalNativeView;
      const ownOff = originalNativeView.hasOwnProperty('off');
      originalNativeView.off = function() {
        navigatedFromHandler = null;
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
  };

  const createPage = () => {
    const oldNativeView = nativePageElement.nativeView;
    // cleanup
    // we want nativePageElement to be null for createComponent -> afterMount
    // to update it
    const removeInsertionPoint = true;
    destroyComponent(removeInsertionPoint);
    // rerender
    const target = document.createElement('fragment');
    createComponent(target, null);
    afterMount(target); // udpates nativePageElement
    // update event proxy
    oldNativeView.off('navigatedFrom', relayNativeNavigatedFrom);
    nativePageElement.nativeView.on('navigatedFrom', relayNativeNavigatedFrom);
  };

  const rerenderNativePage = () => {
    if (pageRenavigate) {
      const frame = nativePageElement.nativeView.frame;
      if (!frame) {
        // wtf? hopefully a race condition with a destroyed component, so
        // we have nothing more to do here
        //
        // for once, it happens when hot reloading dev deps, like this file
        //

        return;
      }
      const isCurrentPage = frame.currentPage === nativePageElement.nativeView;
      // console.log('rerender native page, current:', isCurrentPage);
      if (isCurrentPage) {
        createPage();

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
              resolvedPage: nativePageElement.nativeView,
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
          const nativeView = nativePageElement.nativeView;
          frame.navigate({
            // animated: false,
            create: () => nativeView,
            clearHistory: true,
          });
        }
      } else {
        const backEntry = frame.backStack.find(
          ({ resolvedPage: page }) => page === nativePageElement.nativeView
        );
        if (!backEntry) {
          // well... looks like we didn't make it to history after all
          return;
        }
        // replace existing nativeView
        createPage();
        backEntry.resolvedPage = nativePageElement.nativeView;
      }
    } else {
      destroyComponent();
      const removeChild = child => nativePageElement.removeChild(child);
      nativePageElement.childNodes.forEach(removeChild);
      createComponent(nativePageElement, null);
    }
  };

  return Object.assign({}, domAdapter, {
    afterMount,
    destroyComponent,
    rerender,
  });
};
