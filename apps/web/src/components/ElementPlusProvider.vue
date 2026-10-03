<script setup lang="ts">
import { getCurrentInstance } from "vue"
import {
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElDatePicker,
  ElDialog,
  ElDrawer,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElOption,
  ElProgress,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElSegmented,
  ElSelect,
  ElSlider,
  ElSwitch,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTooltip
} from "element-plus"

const app = getCurrentInstance()?.appContext.app
for (const component of [
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElDatePicker,
  ElDialog,
  ElDrawer,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElOption,
  ElProgress,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElSegmented,
  ElSelect,
  ElSlider,
  ElSwitch,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTooltip
]) {
  if (app && component.name) app.component(component.name, component)
}

</script>

<template><slot /></template>
