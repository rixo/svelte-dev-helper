/* global document */

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

import Registry from './registry';

export { Registry };

const proxyOptions = {
  noPreserveState: false,
  // enable/disable native support
  native: false,
};

// internal options for now, would love to not actually need it
const nativeOptions = {
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
  pageRenavigate: true,
};

const handledMethods = [
  '$destroy'
];
const forwardedMethods = [
  '$set',
  '$on',
];
const $$Properties = [
  'ctx',
  // state
  'props',
  'update',
  'not_equal',
  'bound',
  // lifecycle
  'on_mount',
  'on_destroy',
  'before_render',
  'after_render',
  'context',
  // everything else
  'callbacks',
  'dirty',
];
const fragmentMethods = {
  c: true, // create
  l: true, // claim
  m: true, // mount
  p: true, // update
  i: true, // intro
  o: true, // outro
  d: true, // destroy
};

const isNative = () => !!proxyOptions.native;

function capitalize(str) {
  return str[0].toUpperCase() + str.slice(1);
}

function posixify(file) {
  return file.replace(/[/\\]/g, '/');
}

function getDebugName(id) {
  const posixID = posixify(id);
  const name = posixID
    .split('/')
    .pop()
    .split('.')
    .shift();
  return `<${capitalize(name)}>`;
}

const removeElement = el => el && el.parentNode && el.parentNode.removeChild(el);

export function configure(_options) {
  Object.assign(proxyOptions, _options);
}

export function getConfig() {
  return proxyOptions;
}

// proxies properties to a changing target
const relayProperties = (getTarget, keys) => {
  const dest = {};
  keys.forEach(key => {
    Object.defineProperty(dest, key, {
      get() {
        const target = getTarget();
        return target && target[key];
      },
      set(value) {
        const target = getTarget();
        if (target && target.$$) {
          target.$$[key] = value;
        }
      }
    });
  });
  return dest;
};

/**
 * Proxies method calls to a changing target, allowing to hook before & after.
 *
 * `getTarget` is a function that resolves the target. The function is called
 * just in time, so it always use the last target. If no target is available
 * at the time of a call, then the operation is silently ignored.
 *
 * `spec` can be a array of string representing the name of the method to be
 * proxied, or an object. As an object, the keys are the name of the methods,
 * and the value can be:
 *
 * - `true`: just relay to the target
 *
 * - `function`: a function that is called after the proxied method, with is
 *    passed the result of the wrapped
 *
 * - an object of the form `{before, after}` if also need to hook before the
 *   proxied function
 *
 * @param {Function} getTarget
 * @param {string[]|Object} spec
 * @param {Object} [dest]
 */
const relayCalls = (getTarget, spec, dest = {}) => {
  const toSpec = value => [value, true];
  const entries = Array.isArray(spec) ? spec.map(toSpec) : Object.entries(spec);
  entries.forEach(([key, fn]) => {
    if (fn == true) {
      dest[key] = function(...args) {
        const target = getTarget();
        if (!target || !target[key]) {
          return;
        }
        return target[key].call(this, ...args);
      };
    }
    let before;
    let after;
    if (typeof fn === 'function') {
      after = fn;
    } else if (typeof fn === 'object') {
      before = fn.before;
      after = fn.after;
    }
    dest[key] = function(...args) {
      const target = getTarget();
      if (!target) {
        return;
      }
      if (before) before(...args);
      const result = target[key] && target[key].call(this, ...args);
      if (after) after(...args);
      return result;
    };
  });
  return dest;
};

const copyComponentMethods = (proxy, cmp) => {
  //proxy custom methods
  const methods = Object.getOwnPropertyNames(
    Object.getPrototypeOf(cmp)
  );
  methods.forEach(method => {
    if (
      !handledMethods.includes(method) &&
      !forwardedMethods.includes(method)
    ) {
      proxy[method] = function() {
        return cmp[method].apply(cmp, arguments);
      };
    }
  });
};

const captureState = cmp => {
  if (!cmp || !cmp.$$) return null;
  const { $$:{ callbacks } } = cmp;
  return { callbacks };
};

const restoreState = (cmp, restore) => {
  if (!restore) return;
  const { callbacks } = restore;
  if (callbacks) {
    cmp.$$.callbacks = callbacks;
  }
};

// Creates a new instance of the proxied component, and attach it behind
// the existing proxy instance.
const createComponent = (proxy, state, options, restore) => {
  const {
    id,
    debugName,
  } = state;
  const record = Registry.get(id);
  try {
    // resolve to latest version of component
    const cmp = new record.component(options);
    copyComponentMethods(proxy, cmp);
    // restore state
    if (restore) {
      restoreState(cmp, restore);
    }
    return cmp;
  } catch (e) {
    const rb = record.rollback;
    if (!rb) {
      // FIXME full reload on error
      console.error(
        'Full reload required due to error in component ' + debugName
      );
      throw e;
    }
    delete record.rollback;
    // resolve to previous working version of component
    // set latest version as the rolled-back version
    record.component = rb;
    Registry.set(id, record);
    console.info(
      '%c' + debugName + ' rolled back to previous working version',
      'color:green'
    );
    // recurse to ensure proper post processing (copy methods) & error handling
    return createComponent(proxy, state, options, restore);
  }
};

class ProxyComponent {
  constructor(id, options) {
    const proxy = this;

    const record = { id, _rerender };

    //register current instance, so that
    //we can re-render it when required
    Registry.registerInstance(record);

    const debugName = getDebugName(id);

    const state = {
      id,
      debugName,
      options,
    };
    let cmp;
    let insertionPoint;
    let nativePageElement;

    const afterMount = (target, anchor) => {
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
      const isNativePage = isNative() && target.tagName === 'fragment';
      if (isNativePage) {
        nativePageElement = target.firstChild;
      } else if (!insertionPoint) {
        insertionPoint = document.createComment(debugName);
        target.insertBefore(insertionPoint, anchor);
        // try to protect against components changing from page to no-page
        // or vice versa -- see DEBUG 1 above. NOT TESTED so prolly not working
        nativePageElement = null;
      }
      state.target = target;
      state.anchor = anchor;
    };

    // ---- component internals ----

    const get$$ = () => cmp && cmp.$$;

    const getFragment = () => cmp && cmp.$$.fragment;

    this.$$ = relayProperties(get$$, $$Properties);

    this.$$.fragment = relayCalls(
      getFragment,
      Object.assign({}, fragmentMethods, {
        m: afterMount,
      })
    );

    // ---- create & mount target component instance ---

    cmp = createComponent(this, state, options);

    // Svelte 3 creates and mount components from their constructor if
    // options.target is present.
    //
    // This means that at this point, the component's `fragment.c` and,
    // most notably, `fragment.m` will already have been called _from inside
    // createComponent_. That is: before we have a change to hook on it.
    //
    // Proxy's constructor
    //   -> createComponent
    //     -> component constructor
    //       -> component.$$.fragment.c(...) (or l, if hydrate:true)
    //       -> component.$$.fragment.m(...)
    //
    //   -> you are here <-
    //
    // I've tried to move the responsibility for mounting the component here,
    // by setting `$$inline` option to prevent Svelte from doing it itself.
    // `$$inline` is normally used for child components, and their lifecycle
    // is managed by their parent. But that didn't go too well.
    //
    // We want the proxied component to be mounted on the DOM anyway, so it's
    // easier to let Svelte do its things and manually execute our `afterMount`
    // hook ourself (will need to do the same for `c` and `l` hooks, if we
    // come to need them here).
    //
    if (options.target) {
      afterMount(options.target, options.anchor);
    }

    // ---- forwarded methods ----

    relayCalls(() => cmp, forwardedMethods, this);

    // ---- augmented methods ----

    this.$destroy = () => {
      Registry.deRegisterInstance(record);
      // Component is being destroyed, detaching is not optional in Svelte3's
      // public component API, so we can dispose of the insertion point in
      // every case.
      const removeInsertionPoint = true;
      destroyCmp(removeInsertionPoint);
    };

    function destroyCmp(removeInsertionPoint) {
      if (cmp) {
        cmp.$destroy();
        cmp = null;
      }
      if (removeInsertionPoint) {
        if (insertionPoint) {
          removeElement(insertionPoint);
          insertionPoint = null;
        }
        if (nativePageElement) {
          // native cleaning will happen when navigating back from the page
          nativePageElement = null;
        }
      }
    }

    // ---- Re render ----

    // This is the only view that is known by svelte-native. It will put
    // a navigatedFrom listener on it, and destroy the instance (i.e. our
    // proxy instance) in it.
    let originalNativeView;
    let navigatedFromHandler;
    if (nativePageElement) {
      originalNativeView =  nativePageElement.nativeView;
      const { on } = originalNativeView;
      const ownOn = originalNativeView.hasOwnProperty('on');
      // tricks svelte-native into giving us its handler
      originalNativeView.on = function(type, handler, ...rest) {
        if (type === 'navigatedFrom') {
          navigatedFromHandler = handler;
          if  (ownOn) {
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
    }
    function relayNativeNavigatedFrom(args) {
      if (!args.isBackNavigation) {
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
    }

    const rerenderNativePage = (() => {
      const createPage = props => {
        const oldNativeView = nativePageElement.nativeView;
        // state
        const restore = captureState(cmp);
        // cleanup
        // we want nativePageElement to be null for createComponent -> afterMount
        // to update it
        const removeInsertionPoint = true;
        destroyCmp(removeInsertionPoint);
        // rerender
        const target = document.createElement('fragment');
        const opts = Object.assign({}, options, { target, props });
        cmp = createComponent(proxy, state, opts, restore);
        afterMount(target); // udpates nativePageElement
        // update event proxy
        oldNativeView.off('navigatedFrom', relayNativeNavigatedFrom);
        nativePageElement.nativeView.on('navigatedFrom', relayNativeNavigatedFrom);
      };

      return function rerenderNativePage(ctx) {
        const props = ctx;
        if (nativeOptions.pageRenavigate) {
          const frame = nativePageElement.nativeView.frame;
          if (!frame) {
            // wtf? hopefully a race condition with a destroyed component, so
            // we have nothing more to do here
            //
            // for once, it happens when hot reloading dev deps, like this file
            //
            debugger;
            return;
          }
          const isCurrentPage = frame.currentPage === nativePageElement.nativeView;
          // console.log('rerender native page, current:', isCurrentPage);
          if (isCurrentPage) {
            createPage(props);

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
                  frameId: currentBackstackEntry.frameId
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
            createPage(props);
            backEntry.resolvedPage = nativePageElement.nativeView;
          }
        } else {
          const restore = captureState(cmp);
          destroyCmp();
          const removeChild = child => nativePageElement.removeChild(child);
          nativePageElement.childNodes.forEach(removeChild);
          const opts = Object.assign({}, options, {
            target: nativePageElement,
            props,
          });
          cmp = createComponent(proxy, state, opts, restore);
        }
      };
    })();

    function rerenderDefault(ctx) {
      const restore = captureState(cmp);
      destroyCmp();
      if (!insertionPoint) {
        throw new Error('Illegal state: missing insertion point');
      }
      const opts = Object.assign({}, options, {
        target: insertionPoint.parentNode,
        anchor: insertionPoint,
        props: ctx,
      });
      cmp = createComponent(proxy, state, opts, restore);
    }

    function _rerender() {
      if (!cmp) {
        console.log(
          'Trying to rerender an already destroyed component?',
          debugName
        );
        return;
      }
      const ctx = cmp.$$ && cmp.$$.ctx;
      if (nativePageElement) {
        rerenderNativePage(ctx);
        return;
      }
      rerenderDefault(ctx);
    }
  }
}

/*
creates a proxy object that
decorates the original component with trackers
and ensures resolution to the
latest version of the component
*/
export function createProxy(id) {

  class proxyComponent extends ProxyComponent {
    constructor(options) {
      super(id, options);
    }
  }

  // Copy static methods & props
  //
  // This needs to be done:
  //
  // - each time the component is modified by HMR
  //
  // - before Proxy instances' proxied component is recreated (because a
  //   static prop/method may be used in the create/mount lifecycle that
  //   is triggered by the component's constructor)
  //
  // - only once per HMR update, and per Proxy class, irrelevantly of whether
  //   we currently have 0, 1, or n existing proxy instances
  //
  // record.copyStatics will be called by loader on reload events.
  //
  const copyStatics = () => {
    //forward static properties and methods
    const originalComponent = Registry.get(id).component;
    for (let key in originalComponent) {
      proxyComponent[key] = originalComponent[key];
    }
  };

  const record = Registry.get(id);
  record.copyStatics = copyStatics;
  Registry.set(id, record);

  copyStatics();

  return proxyComponent;
}
