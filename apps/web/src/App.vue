<script setup lang="ts">
import { onMounted } from "vue"
import { useSessionStore } from "./stores/session"
import LoginView from "./components/LoginView.vue"
import { defineAsyncComponentWithLoading } from "./async-component"

const PlatformView = defineAsyncComponentWithLoading(() => import("./components/PlatformView.vue"))
const ElementPlusProvider = defineAsyncComponentWithLoading(() => import("./components/ElementPlusProvider.vue"))

const session = useSessionStore()
onMounted(() => session.restore())
</script>

<template>
  <div v-if="session.loading" class="splash-screen">
    <div class="splash-mark">YZ</div>
    <span>正在加载仿真实训平台</span>
  </div>
  <LoginView v-else-if="!session.user" />
  <ElementPlusProvider v-else>
    <PlatformView :user="session.user" @logout="session.logout" />
  </ElementPlusProvider>
</template>
