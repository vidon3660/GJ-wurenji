<script setup lang="ts">
import { ref } from "vue"
import { useSessionStore } from "../stores/session"

const session = useSessionStore()
const email = ref("teacher@demo.local")
const password = ref("")
const submitting = ref(false)
const passwordVisible = ref(false)
const errorMessage = ref("")

async function login() {
  if (submitting.value) return
  submitting.value = true
  errorMessage.value = ""
  try {
    await session.login(email.value, password.value)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "登录失败"
  } finally {
    submitting.value = false
  }
}

function useDemo(role: "teacher" | "student") {
  email.value = role === "teacher" ? "teacher@demo.local" : "student@demo.local"
  password.value = ""
  void login()
}
</script>

<template>
  <main class="login-page">
    <section class="login-visual" aria-label="平台场景预览">
      <div class="brand-lockup">
        <span class="brand-symbol" aria-hidden="true"><i class="login-compass-icon" /></span>
        <div><strong>高巨低空无人集群虚拟仿真平台</strong></div>
      </div>
      <div class="city-scene" aria-hidden="true">
        <span class="forest-canopy forest-canopy--one" />
        <span class="forest-canopy forest-canopy--two" />
        <span class="hero-light hero-light--one" />
        <span class="hero-light hero-light--two" />
        <span class="hero-drone"><i class="hero-drone-body" /><i class="hero-drone-arm hero-drone-arm--left" /><i class="hero-drone-arm hero-drone-arm--right" /><i class="hero-drone-camera" /></span>
      </div>
      <div class="visual-caption">
        <strong>低空集群实训</strong>
        <span>二维规划与三维仿真，一体化教学</span>
      </div>
    </section>

    <section class="login-panel">
      <div class="login-form">
        <header><span>教学实训平台</span><h1>进入工作台</h1><p>教师或学生账号登录</p></header>
        <form class="login-native-form" :aria-busy="submitting" @submit.prevent="login">
          <label class="login-field">
            <span>账号邮箱</span>
            <span class="login-input-wrapper">
              <i class="login-field-icon login-field-icon--message" aria-hidden="true" />
              <input v-model="email" type="email" name="email" autocomplete="username" placeholder="邮箱地址" required />
            </span>
          </label>
          <label class="login-field">
            <span>登录密码</span>
            <span class="login-input-wrapper">
              <i class="login-field-icon login-field-icon--lock" aria-hidden="true" />
              <input v-model="password" :type="passwordVisible ? 'text' : 'password'" name="password" autocomplete="current-password" placeholder="密码" required />
              <button class="login-password-toggle" type="button" :title="passwordVisible ? '隐藏密码' : '显示密码'" :aria-label="passwordVisible ? '隐藏密码' : '显示密码'" @click="passwordVisible = !passwordVisible">
                <i :class="passwordVisible ? 'login-visibility-icon login-visibility-icon--hidden' : 'login-visibility-icon'" aria-hidden="true" />
              </button>
            </span>
          </label>
          <p v-if="errorMessage" class="login-error" role="alert">{{ errorMessage }}</p>
          <button class="login-submit login-button login-button--primary" type="submit" :disabled="submitting">
            {{ submitting ? '正在登录...' : '登录平台' }}
          </button>
        </form>
        <div class="demo-divider"><span>演示账号</span></div>
        <div class="demo-actions">
          <button class="login-button login-button--secondary" type="button" :disabled="submitting" @click="useDemo('teacher')">教师演示</button>
          <button class="login-button login-button--secondary" type="button" :disabled="submitting" @click="useDemo('student')">学生演示</button>
        </div>
      </div>
    </section>
  </main>
</template>
