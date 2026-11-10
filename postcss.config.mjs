// Tailwind CSS v4 的 PostCSS 管道配置。
// 说明：脚手架使用的 Vite 8（rolldown 内核）下 @tailwindcss/vite 插件未能正确处理
// 样式，改用与打包器解耦的 PostCSS 方式，官方同等支持。
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
