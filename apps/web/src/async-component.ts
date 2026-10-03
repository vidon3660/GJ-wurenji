import { defineAsyncComponent, h } from "vue"
import type { AsyncComponentLoader, Component } from "vue"

export function defineAsyncComponentWithLoading<T extends Component>(loader: AsyncComponentLoader<T>) {
  return defineAsyncComponent<T>({
    loader,
    delay: 150,
    loadingComponent: {
      setup() {
        return () => h("div", { class: "async-view-loading", role: "status" }, "正在加载页面")
      }
    },
    errorComponent: {
      setup() {
        return () => h("div", { class: "async-view-error", role: "alert" }, "页面加载失败，请刷新页面或重新进入")
      }
    },
    timeout: 30000,
    onError(error, retry, fail, attempts) {
      if (attempts <= 2) {
        setTimeout(retry, attempts * 250)
        return
      }
      fail()
    }
  })
}
