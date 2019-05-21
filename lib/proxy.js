/* global document */

import Registry from './registry';

export { Registry };

let proxyOptions = {
  noPreserveState: false,
};

const native = resolveNative();
const nativeOptions = {
  // in most cases, renavigating is not useful and pretty ugly, but if the
  // page itself or its title bar (maybe others...) change, HMR won't be able
  // to reflect this change with current strategy
  //
  // renavigating to the page solves this problem because the page is fully
  // recreated, but it messes navigation history stack, and also that usely
  // play a transition that is annoying in our case
  //
  // ideally, HMR should only renavigate only if it detects changes to the
  // page itself
  //
  // or, even more ideally, we could find a way to recreate & replace the
  // whole page without messing with history or transition. there's an issue
  // requiring a change in NativeScript's navigation to allow this (and it is
  // supported by members of Vue native team, who have the same problem).
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

function resolveNative() {
  try {
    return require('svelte-native');
  } catch (err) {
    return null;
  }
}

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

export function configure(_options) {
  proxyOptions = Object.assign(proxyOptions, _options);
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

// proxies method calls to a changing target, allowing to hook before & after
const relayCalls = (getTarget, spec) => {
  const dest = {};
  Object.entries(spec).forEach(([key, fn]) => {
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

// Creates a new instance of the proxied component, and attach it behing
// the existing proxy instance.
const createComponent = (proxy, state, options) => {
  const {
    id,
    debugName,
  } = state;
  const record = Registry.get(id);
  try {
    // resolve to latest version of component
    const cmp = new record.component(options);
    copyComponentMethods(proxy, cmp);
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

    // XXX
    // const getTarget = (key, defaultValue) =>
    //   cmp && cmp.$$[key] || defaultValue;
    //
    // const setTarget = (key, value) => {
    //   if (!cmp) return;
    //   cmp.$$[key] = value;
    // };

    const afterMount = (target, anchor) => {
      if (!insertionPoint && !nativePageElement) {
        if (native && target.tagName === 'fragment') {
          nativePageElement = target.firstChild;
        } else {
          insertionPoint = document.createComment(debugName);
          target.insertBefore(insertionPoint, anchor);
        }
      }
      state.target = target;
      state.anchor = anchor;
    };

    // XXX
    // {
    //   const keys = [
    //     'ctx',
    //     // state
    //     'props',
    //     'update',
    //     'not_equal',
    //     'bound',
    //     // lifecycle
    //     'on_mount',
    //     'on_destroy',
    //     'before_render',
    //     'after_render',
    //     'context',
    //     // everything else
    //     'callbacks',
    //     'dirty',
    //   ];
    //   const $$ = {};
    //   keys.forEach(key => {
    //     Object.defineProperty($$, key, {
    //       get() {
    //         return getTarget(key, []);
    //       },
    //       set(value) {
    //         setTarget(key, value);
    //       }
    //     });
    //   });
    //   this.$$ = $$;
    // }

    this.$$ = relayProperties(
      () => cmp && cmp.$$,
      [
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
      ]
    );

    this.$$.fragment = relayCalls(
      () => cmp && cmp.$$.fragment,
      {
        c: true, // create
        l: true, // claim
        m: afterMount, // mount
        p: true, // update
        i: true, // intro
        o: true, // outro
        d: true, // destroy
      }
    );

    cmp = createComponent(this, state, options);
    // svelte3 creates and mount components from their constructor if
    // options.target is present
    //
    // this also means DEBUG
    //
    if (options.target) {
      afterMount(options.target, options.anchor);
    }

    // ---- forwarded methods ----
    forwardedMethods.forEach(method => {
      this[method] = function() {
        return cmp[method].apply(cmp, arguments);
      };
    });
    // ---- END forwarded methods ----

    // ---- augmented methods ----

    this.$destroy = () => {
      console.log('$destroy', debugName);
      Registry.deRegisterInstance(record);
      // const ip = this.__insertionPoint;
      // if (!keepInsertionPoint && ip) {
      //   //deref for GC before removal of node
      //   ip.__component__ = null;
      //   ip.parentNode && ip.parentNode.removeChild(ip);
      // }
      if (cmp) {
        cmp.$destroy();
        cmp = null;
      }
    };

    // ---- Re render ----

    function rerenderNativePage(ctx) {
      if (nativeOptions.pageRenavigate) {
        const frame = nativePageElement.nativeView.frame;
        const record = Registry.get(id);
        if (frame.canGoBack()) {
          frame.goBack();
        }
        native.navigate({
          // page: record.component,
          page: record.proxy,
          frame: nativePageElement.nativeView.frame,
          // backstackVisible: false,
          props: ctx,
        });
      } else {
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
      if (!insertionPoint) {
        throw new Error('Illegal state: missing insertion point');
      }
      const opts = Object.assign({}, options, {
        target: insertionPoint.parentNode,
        anchor: insertionPoint.nextSibling,
        props: ctx
      });
      cmp = createComponent(proxy, state, opts);
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
      cmp.$destroy();
      cmp = null;
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

  // this needs to be done each time the component is modified
  //
  // - before DEBUG
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
