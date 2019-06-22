// import Registry from './registry';
// import { configure, getConfig } from './config';
import DomAdapter from './proxy-adapter-dom';

// export { Registry, configure, getConfig };

const handledMethods = ['$destroy'];
const forwardedMethods = ['$set', '$on'];
const $$_keys = [
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
// NOTE c, l, h & m (at least?) are not reliably hookable from the proxy
// because they may get called from the component constructor -- before the
// proxy has had any change to rewire the component.
//
// So, if the component is immediately created (which happens if it has a
// target in constructor option), the calls are has follow:
//
// proxy.constructor
//   -> cmp.constructor
//     -> cmp.c
//       -> cmp.h (if hydratable)
//     -> cmp.m
//
// As compared, when proxy has shadowed the component:
//
// proxy.constructor
//   -> cmp.constructor
//     -> proxy.c
//       -> cmp.c
//         -> proxy.h (if hydratable)
//           -> cmp.h
//       -> proxy.m
//         -> cmp.m
//
// For now, we only use the m hook, and we call it ourselve if we see that the
// component has been mounted at creation time.
//
const fragmentMethods = {
  c: true, // create
  l: true, // claim
  h: true, // hydrate
  m: true, // mount
  p: true, // update
  i: true, // intro
  o: true, // outro
  d: true, // destroy
};

const noop = () => {};

const captureState = cmp => {
  // sanity check: propper behaviour here is to crash noisily so that
  // user knows that they're looking at something broken
  if (!cmp) {
    throw new Error('Missing component');
  }
  if (!cmp.$$) {
    throw new Error('Invalid component');
  }
  const {
    $$: { callbacks, ctx },
  } = cmp;
  const props = cmp.$capture_state ? cmp.$capture_state() : ctx;
  return { props, callbacks };
};

const restoreState = (cmp, restore) => {
  if (!restore) {
    return;
  }
  const { callbacks, props } = restore;
  if (callbacks) {
    cmp.$$.callbacks = callbacks;
  }
  if (props) {
    cmp.$inject_state(restore.props)
  }
  // props, props.$$slots are restored at component creation (works
  // better -- well, at all actually)
};

const posixify = file => file.replace(/[/\\]/g, '/');

const getBaseName = id =>
  id
    .split('/')
    .pop()
    .split('.')
    .shift();

const capitalize = str => str[0].toUpperCase() + str.slice(1);

const getFriendlyName = id => capitalize(getBaseName(posixify(id)));

const getDebugName = id => `<${getFriendlyName(id)}>`;

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
      },
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
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(cmp));
  methods.forEach(method => {
    if (
      !handledMethods.includes(method) &&
      !forwardedMethods.includes(method)
    ) {
      proxy[method] = function() {
        // DEBUG what's the propper scope here?
        // return cmp[method].apply(cmp, arguments);
        return cmp[method].apply(this, arguments);
      };
    }
  });
};

// TODO clean this extremely add-hoc, coupled, & fragile code
// TODO native this must respect Page/Frame interface... or need tolerance from SN
const createErrorProxy = (adapter, err, target, anchor) => {
  const cmp = {
    $destroy: noop,
    $set: noop,
    $$: {
      fragment: {
        c: noop, // create
        l: noop, // claim
        h: noop, // hydrate
        m: (target, anchor) => {
          cmp.$destroy = adapter.renderError(err, target, anchor);
        }, // mount
        p: noop, // update
        i: noop, // intro
        o: noop, // outro
        d: noop, // destroy
      },
      ctx: {},
      // state
      props: [],
      update: noop,
      not_equal: noop,
      bound: {},
      // lifecycle
      on_mount: [],
      on_destroy: [],
      before_render: [],
      after_render: [],
      context: {},
      // everything else
      callbacks: [],
      dirty: noop,
    },
  };
  if (target) {
    cmp.$destroy = adapter.renderError(err, target, anchor);
  }
  return cmp;
};

// everything in the constructor!
//
// so we don't interfere the component class with new members
//
// specificity & conformance with Svelte component constructor is achieved
// in the "component level" (as opposed "instance level") createRecord
//
class ProxyComponent {
  constructor(
    {
      Adapter,
      id,
      debugName,
      current, // { component, hotOptions: { noPreserveState, ... } }
      register,
      unregister,
    },
    options // { target, anchor, ... }
  ) {
    let cmp;
    let restore;

    // it's better to restore props from the very beginning -- for example
    // slots (yup, stored in props as $$slots) are broken if not present at
    // component creation and later restored with $set
    const restoreProps = restore => {
      return restore && restore.props && { props: restore.props };
    };

    const doCreateComponent = (target, anchor) => {
      const { component } = current;
      const opts = Object.assign(
        {},
        options,
        { target, anchor },
        restoreProps(restore)
      );
      cmp = new component(opts);
      copyComponentMethods(this, cmp);
      restoreState(cmp, restore);
    };

    const createComponent = (target, anchor) => {
      try {
        doCreateComponent(target, anchor);
        return true;
      } catch (err) {
        setError(err, target, anchor);
      }
      return false;
    };

    const destroyComponent = () => {
      // destroyComponent is tolerant (don't crash on no cmp) because it
      // is possible that reload/rerender is called after a previous
      // createComponent has failed (hence we have a proxy, but no cmp)
      if (cmp) {
        restore = captureState(cmp);
        cmp.$destroy();
      }
      cmp = null;
    };

    const refreshComponent = (target, anchor, conservativeDestroy) => {
      if (conservativeDestroy) {
        const prevCmp = cmp;
        restore = captureState(cmp);
        const created = createComponent(target, anchor);
        if (created) {
          prevCmp.$destroy();
          return true;
        } else {
          cmp = prevCmp;
          return false;
        }
      } else {
        destroyComponent();
        const created = createComponent(target, anchor);
        return created;
      }
    };

    const setError = (err, target, anchor) => {
      if (!err) {
        adapter.rerender();
      }
      // log
      console.warn('[Svelte HMR] Failed to recreate component instance', err);
      // create a noop comp to trap Svelte's calls
      if (cmp) {
        cmp.$destroy();
      }
      cmp = createErrorProxy(adapter, err, target, anchor);
    };

    const instance = {
      hotOptions: current.hotOptions,
      proxy: this,
      id,
      debugName,
      refreshComponent,
    };

    if (current.hotOptions.noPreserveState) {
      instance.captureState = noop;
      instance.restoreState = noop;
    }

    const adapter = new Adapter(instance);

    const { afterMount, rerender } = adapter;

    // ---- register proxy instance ----

    register(rerender);

    // ---- augmented methods ----

    this.$destroy = () => {
      destroyComponent();
      adapter.dispose();
      unregister();
    };

    // ---- forwarded methods ----

    const getComponent = () => cmp;
    const get$$ = () => cmp && cmp.$$;
    const getFragment = () => cmp && cmp.$$ && cmp.$$.fragment;

    relayCalls(getComponent, forwardedMethods, this);

    this.$$ = relayProperties(get$$, $$_keys);

    this.$$.fragment = relayCalls(
      getFragment,
      Object.assign({}, fragmentMethods, {
        m: afterMount,
      })
    );

    // ---- create & mount target component instance ---

    {
      const { component } = current;
      const { target, anchor } = options;
      // copy statics before doing anything because a static prop/method
      // could be used somewhere in the create/render call
      copyStatics(component, this);

      const created = createComponent(target, anchor);
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
      if (target && created) {
        afterMount(target, anchor);
      }
    }
  }
}

const copyStatics = (component, proxy) => {
  //forward static properties and methods
  for (let key in component) {
    proxy[key] = component[key];
  }
};

/*
creates a proxy object that
decorates the original component with trackers
and ensures resolution to the
latest version of the component
*/
export const initProxy = (Adapter = DomAdapter) =>
  function createProxy(id, component, hotOptions) {
    const debugName = getDebugName(id);
    const instances = [];

    // current object will be updated, proxy instances will keep a ref
    const current = {
      component,
      hotOptions,
    };

    const proxy = class extends ProxyComponent {
      constructor(options) {
        super(
          {
            Adapter,
            id,
            debugName,
            current,
            register: rerender => {
              instances.push(rerender);
            },
            unregister: () => {
              const i = instances.indexOf(this);
              instances.splice(i, 1);
            },
          },
          options
        );
      }
    };

    const reload = ({ component, hotOptions }) => {
      // update current references
      Object.assign(current, { component, hotOptions });
      // TODO delete props/methods previously added and of which value has
      // not changed since
      copyStatics(component, proxy);
      instances.forEach(rerender => rerender());
    };

    return { id, proxy, reload };
  };
