<script setup lang="ts">
import { useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'

withDefaults(defineProps<{ title?: string; back?: boolean; brand?: boolean }>(), {
  title: '',
  back: false,
  brand: false
})

const router = useRouter()

function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/')
}
</script>

<template>
  <header class="app-header">
    <button v-if="back" class="icon-btn" aria-label="返回" @click="goBack">
      <AppIcon name="back" :size="20" />
    </button>
    <div class="grow row" style="gap: 8px">
      <span v-if="brand" class="brand">
        <span class="brand-seal" aria-hidden="true">暦</span>
        <span class="brand-word">KOYOMI</span>
      </span>
      <h1 v-else>{{ title }}</h1>
    </div>
    <slot name="right" />
  </header>
</template>
