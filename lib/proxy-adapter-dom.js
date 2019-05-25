/* global document */

const removeElement = el => el && el.parentNode && el.parentNode.removeChild(el);

export default class ProxyAdapterDom {
  constructor(instance) {
    this.instance = instance;
    this.insertionPoint = null;

    this.afterMount = this.afterMount.bind(this);
    this.rerender = this.rerender.bind(this);
  }

  // init() {
  //   const {
  //     instance: {
  //       initialOptions: { target, anchor },
  //     },
  //   } = this;
  //
  //   this.createComponent(target, anchor);
  //
  //   // Svelte 3 creates and mount components from their constructor if
  //   // options.target is present.
  //   //
  //   // This means that at this point, the component's `fragment.c` and,
  //   // most notably, `fragment.m` will already have been called _from inside
  //   // createComponent_. That is: before we have a change to hook on it.
  //   //
  //   // Proxy's constructor
  //   //   -> createComponent
  //   //     -> component constructor
  //   //       -> component.$$.fragment.c(...) (or l, if hydrate:true)
  //   //       -> component.$$.fragment.m(...)
  //   //
  //   //   -> you are here <-
  //   //
  //   // I've tried to move the responsibility for mounting the component here,
  //   // by setting `$$inline` option to prevent Svelte from doing it itself.
  //   // `$$inline` is normally used for child components, and their lifecycle
  //   // is managed by their parent. But that didn't go too well.
  //   //
  //   // We want the proxied component to be mounted on the DOM anyway, so it's
  //   // easier to let Svelte do its things and manually execute our `afterMount`
  //   // hook ourself (will need to do the same for `c` and `l` hooks, if we
  //   // come to need them here).
  //   //
  //   if (target) {
  //     this.afterMount(target, anchor);
  //   }
  // }

  dispose() {
    // Component is being destroyed, detaching is not optional in Svelte3's
    // component API, so we can dispose of the insertion point in every case.
    if (this.insertionPoint) {
      removeElement(this.insertionPoint);
      this.insertionPoint = null;
    }
  }

  afterMount(target, anchor) {
    const {
      instance: { debugName },
    } = this;
    // insertionPoint needs to be updated _only when the target changes_ --
    // i.e. when the component is mount, i.e. (in svelte3) when the component
    // is _created_, and svelte3 doesn't allow it to move afterward -- that
    // is, insertionPoint only needs to be created once when the component is
    // first mounted.
    //
    // DEBUG is it really true that components' elements cannot move in the
    // DOM? what about keyed list?
    //
    if (!this.insertionPoint) {
      this.insertionPoint = document.createComment(debugName);
      target.insertBefore(this.insertionPoint, anchor);
    }
  }

  // createComponent(target, anchor) {
  //   try {
  //     this.doCreateComponent(target, anchor);
  //   } catch (err) {
  //     // DEBUG DEBUG DEBUG
  //     // report error
  //   }
  // }
  //
  // doCreateComponent(target, anchor) {
  //   const {
  //     instance: {
  //       createComponent,
  //       initialOptions,
  //       captureState,
  //       restoreState,
  //     },
  //   } = this;
  //   const options = Object.assign({}, initialOptions, { target, anchor });
  //   const restore = captureState();
  //   createComponent(options);
  //   restoreState(restore);
  // }

  rerender() {
    const {
      instance: {
        captureState,
        restoreState,
        createComponent,
        destroyComponent,
      },
      insertionPoint,
    } = this;
    if (!insertionPoint) {
      throw new Error('Cannot rerender: Missing insertion point');
    }
    captureState();
    destroyComponent();
    createComponent(insertionPoint.parentNode, insertionPoint);
    restoreState();
  }
  // rerender() {
  //   const { destroyComponent, insertionPoint } = this;
  //   if (!insertionPoint) {
  //     throw new Error('Cannot rerender: Missing insertion point');
  //   }
  //   destroyComponent();
  //   this.createComponent(insertionPoint.parentNode, insertionPoint);
  // }
}
