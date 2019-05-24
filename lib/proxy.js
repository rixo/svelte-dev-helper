import Registry from './registry';
import { configure, getConfig, observeConfig } from './config';
import DomAdapter from './proxy-adapter-dom';

export { Registry, configure, getConfig };

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

const captureState = cmp => {
  if (!cmp || !cmp.$$) return null;
  const { $$:{ callbacks, ctx } } = cmp;
  const props = ctx;
  return { props, callbacks };
};

const restoreState = (cmp, restore) => {
  if (!restore) return;
  const { callbacks } = restore;
  if (callbacks) {
    cmp.$$.callbacks = callbacks;
  }
};

const posixify = file => file.replace(/[/\\]/g, '/');

const getBaseName = id => id.split('/').pop().split('.').shift();

const capitalize = str => str[0].toUpperCase() + str.slice(1);

const getFriendlyName = id => capitalize( getBaseName( posixify(id) ) );

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
        // DEBUG what's the propper scope here?
        // return cmp[method].apply(cmp, arguments);
        return cmp[method].apply(this, arguments);
      };
    }
  });
};

const resolveComponent = id => {
  const record = Registry.get(id);
  if (!record) {
    throw new Error(`component ${id} has not been registered`);
  }
  const Component = record.component;
  if (!Component) {
    throw new Error(`No component registered for module ${id}`);
  }
  return Component;
};

const rollback = (instance, err) => {
  const { id, debugName } = instance;
  const record = Registry.get(id);
  const rb = record.rollback;
  if (!rb) {
    // FIXME full reload on error
    console.error(
      'Full reload required due to error in component ' + debugName, err
    );
    throw err;
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
};

class ProxyComponent {
  // everything in the constructor!
  //
  // so we don't pollute the component class with new members
  //
  // specificity & conformance with Svelte component constructor is achieved
  // in the "component level" (as opposed "instance level") createRecord
  //
  constructor(Adapter, id, initialOptions) {
    const debugName = getDebugName(id);

    const createComponent = options => {
      const Component = resolveComponent(id);
      const cmp = new Component(options);
      copyComponentMethods(this, cmp);
      return cmp;
    };

    const instance = {
      proxy: this,
      id,
      debugName,
      initialOptions,
      createComponent,
      rollback: err => rollback(instance, err),
      captureState,
      restoreState,
    };

    const adapter = new Adapter(instance);

    const  {
      getComponent,
      get$$,
      getFragment,
      afterMount,
      rerender,
    } = adapter;

    // ---- register proxy instance ----

    instance._rerender = rerender;
    Registry.registerInstance(instance);

    // ---- create & mount target component instance ---

    adapter.init();

    // ---- augmented methods ----

    this.$destroy = () => {
      Registry.deRegisterInstance(instance);
      adapter.dispose();
    };

    // ---- forwarded methods ----

    relayCalls(getComponent, forwardedMethods, this);

    this.$$ = relayProperties(get$$, $$Properties);

    this.$$.fragment = relayCalls(
      getFragment,
      Object.assign({}, fragmentMethods, {
        m: afterMount,
      })
    );
  }
}

/*
creates a proxy object that
decorates the original component with trackers
and ensures resolution to the
latest version of the component
*/
export function createProxy(id) {

  class ModuleProxyComponent extends ProxyComponent {
    constructor(options) {
      super(DomAdapter, id, options);
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
      ModuleProxyComponent[key] = originalComponent[key];
    }
  };

  const record = Registry.get(id);
  record.copyStatics = copyStatics;
  Registry.set(id, record);

  copyStatics();

  return ModuleProxyComponent;
}
