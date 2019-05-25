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
const fragmentMethods = {
  c: true, // create
  l: true, // claim
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
  const props = ctx;
  return { props, callbacks };
};

const restoreState = (cmp, restore) => {
  if (!restore) {
    // calling restore state without a state to restore (even empty)
    // indicates that capture/restore have been called out of order, so
    // there's something cheesy going on... better fail than deceive
    throw new Error('Illegal state');
  }
  const { callbacks } = restore;
  if (callbacks) {
    cmp.$$.callbacks = callbacks;
  }
  if (restore.props) {
    cmp.$set(restore.props);
  }
  // TODO restore slots
  //
  // test:
  // - App contains Child, Child has slot
  // - update Child
  // => (!) slots filled from App are lost
  //
  cmp.$update();
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

// everything in the constructor!
//
// so we don't pollute the component class with new members
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
      component: initialComponent,
      register,
      unregister,
      hotOptions: { noPreserveState = false },
    },
    initialOptions
  ) {
    let component = initialComponent;
    let options = initialOptions;

    let cmp;
    let restore;

    const createComponent = (target, anchor) => {
      const opts = Object.assign({}, options, { target, anchor });
      cmp = new component(opts);
      copyComponentMethods(this, cmp);
      return cmp;
    };

    const destroyComponent = () => {
      // destroyComponent is tolerant (don't crash on no cmp) because it
      // is possible that reload/rerender is called after a previous
      // createComponent has failed (hence we have a proxy, but no cmp)
      if (cmp) {
        cmp.$destroy();
      }
      cmp = null;
    };

    const instance = {
      proxy: this,
      id,
      debugName,
      initialOptions,
      createComponent,
      destroyComponent,
      captureState: () => {
        restore = captureState(cmp);
      },
      restoreState: () => {
        restoreState(cmp, restore);
        restore = null;
      },
    };

    if (noPreserveState) {
      instance.captureState = noop;
      instance.restoreState = noop;
    }

    const adapter = new Adapter(instance);

    const { afterMount, rerender } = adapter;

    // ---- register proxy instance ----

    register((newComponent, newOptions) => {
      component = newComponent;
      options = newOptions;
      rerender();
    });

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
      // copy statics before doing anything because a static prop/method
      // could be used somewhere in the create/render call
      copyStatics(component, this);

      const { target, anchor } = initialOptions;
      createComponent(target, anchor);
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
      if (target) {
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
export function createProxy(id, component, hotOptions) {
  const debugName = getDebugName(id);
  const instances = [];

  const proxy = class extends ProxyComponent {
    constructor(options) {
      super(
        {
          Adapter: DomAdapter,
          id,
          debugName,
          component,
          register: rerender => {
            instances.push(rerender);
          },
          unregister: () => {
            const i = instances.indexOf(this);
            instances.splice(i, 1);
          },
          hotOptions,
        },
        options
      );
    }
  };

  const reload = ({ component, hotOptions }) => {
    // TODO delete props/methods previously added and of which value has
    // not changed since
    copyStatics(component, proxy);
    instances.forEach(rerender => {
      rerender(component, hotOptions);
    });
  };

  return { id, proxy, reload };
}
