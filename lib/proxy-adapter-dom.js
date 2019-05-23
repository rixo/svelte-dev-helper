/* global document */

const removeElement = el => el && el.parentNode && el.parentNode.removeChild(el);

export default ({
  instance,
  captureState,
  restoreState,
  createComponent: _createComponent,
  rollback,

  afterMount,
}) => {
  const { initialOptions, debugName } = instance;

  let cmp;
  let insertionPoint;

  const createComponent = (target, anchor) => {
    const options = Object.assign({}, initialOptions, { target, anchor });
    const restore = captureState(cmp);
    doCreateComponent(options, restore);
  };

  const doCreateComponent = (options, restore) => {
    try {
      cmp = _createComponent(options);
      if (restore) {
        restoreState(cmp, restore);
      }
    } catch (err) {
      // will crash for good if no rollback component available
      rollback(instance, err);
      // recurse to ensure proper post processing (copy methods) & error handling
      return doCreateComponent(options, restore);
    }
  };

  const initAdapter = () => {
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
  };

  const getComponent = () => cmp;

  const get$$ = () => cmp && cmp.$$;

  const getFragment = () => cmp && cmp.$$.fragment;

  const _afterMount = (target, anchor) => {
    // insertionPoint needs to be updated _only when the target changes_ --
    // i.e. when the component is mount, i.e. (in svelte3) when the component
    // is _created_, and svelte3 doesn't allow it to move afterward -- that
    // is, insertionPoint only needs to be created once when the component is
    // first mounted.
    //
    // DEBUG is it really true that components' elements cannot move in the
    // DOM? what about keyed list?
    //
    if (!insertionPoint) {
      insertionPoint = document.createComment(debugName);
      target.insertBefore(insertionPoint, anchor);
    }
  };

  const destroyAdapter = () => {
    // Component is being destroyed, detaching is not optional in Svelte3's
    // public component API, so we can dispose of the insertion point in
    // every case.
    const removeInsertionPoint = true;
    destroyComponent(removeInsertionPoint);
  };

  function destroyComponent(removeInsertionPoint) {
    if (cmp) {
      cmp.$destroy();
      cmp = null;
    }
    if (removeInsertionPoint) {
      if (insertionPoint) {
        removeElement(insertionPoint);
        insertionPoint = null;
      }
    }
  }

  const rerender = () => {
    if (!cmp) {
      console.log('Trying to rerender a destroyed component?', debugName);
      return;
    }
    if (!insertionPoint) {
      throw new Error('Illegal state: missing insertion point');
    }
    destroyComponent();
    createComponent(insertionPoint.parentNode, insertionPoint);
  };

  return {
    initAdapter,
    destroyAdapter,

    afterMount: _afterMount,
    rerender,

    createComponent,
    destroyComponent,

    getComponent,
    get$$,
    getFragment,
  };
};
