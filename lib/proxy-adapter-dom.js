/* global document */

const removeElement = el => el && el.parentNode && el.parentNode.removeChild(el);

export default class ProxyAdapterDom {
  constructor(instance) {
    this.instance = instance;
    this.insertionPoint = null;

    this.afterMount = this.afterMount.bind(this);
    this.rerender = this.rerender.bind(this);
  }

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
    // i.e. when the component is mounted, i.e. (in svelte3) when the component
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
}
