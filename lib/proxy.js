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
// As long as modifications only convern child components of the page, then
// we can keep the existing page and replace its content for HMR.
//
// However, if the page component itself is modified (including its system
// title bar), things get hairy... I have not found a way to replace the
// native view, and I am not sure it is actually possible.
//
// One strategy is to re navigate to the same page (in this case, our Proxy
// of the page component). This does recreate the page element, effectively
// sync'ing code changes... But it also messes the history stack, and the
// renavigation is visible because of the navigation transition, so that's
// pretty ugly too.
//
// For reference, there is an active issue at NativeScript asking for
// support of navigation that doesn't affect the hystory stack (like
// location.replace in the browser), and that can have no visible transition.
// Some devs of Vue loader have expressed interest into this issue, for
// support of their own HMR.
//
// Another way that could be explored would be to use NativeScript's API to
// try to reflect the changes to the page (e.g. title, title bar color, items,
// etc.) without actually changing the underlying page element.

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

// Creates a new instance of the proxied component, and attach it behing
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
    return createComponent(proxy, state, options);
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
      if (!insertionPoint && !nativePageElement) {
        if (isNative && target.tagName === 'fragment') {
          nativePageElement = target.firstChild;
        } else {
          insertionPoint = document.createComment(debugName);
          target.insertBefore(insertionPoint, anchor);
        }
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
        m: afterMount
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
      if (insertionPoint) {
        removeElement(insertionPoint);
        insertionPoint = null;
      }
      destroyCmp();
    };

    // ---- Re render ----

    function destroyCmp() {
      if (cmp) {
        cmp.$destroy();
        cmp = null;
      }
    }

    function rerenderNativePage(ctx) {
      if (nativeOptions.pageRenavigate) {
        // FIXME svelte native pages are a sticky case
        const frame = nativePageElement.nativeView.frame;
        const record = Registry.get(id);
        if (frame.canGoBack()) {
          frame.goBack();
        }
        isNative.navigate({
          // page: record.component,
          page: record.proxy,
          frame: nativePageElement.nativeView.frame,
          // backstackVisible: false,
          props: ctx,
          navigate: false, // use patched svelte-native
        });
      } else {
        destroyCmp();
        const removeChild = child => nativePageElement.removeChild(child);
        nativePageElement.childNodes.forEach(removeChild);
        const opts = Object.assign({}, options, {
          target: nativePageElement,
          props: ctx
        });
        cmp = createComponent(proxy, state, opts);
      }
    }

    function rerenderDefault(ctx) {
      const restore = captureState(cmp);
      destroyCmp();
      if (!insertionPoint) {
        throw new Error('Illegal state: missing insertion point');
      }
      const opts = Object.assign({}, options, {
        target: insertionPoint.parentNode,
        anchor: insertionPoint.nextSibling,
        props: ctx
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
