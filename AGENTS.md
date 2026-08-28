# Paseo 插件项目规范

## Feature 目录组织

新增业务功能时，按 Feature 组织代码，不要把所有客户端和服务端文件集中放在全局目录中。

```text
src/
  features/
    <feature>/
      client.tsx
      server.ts
      shared.ts
  components/      # 多个 Feature 复用的 UI 组件
  lib/             # 跨 Feature 的通用工具
```

除非同步修改插件入口配置，否则 Paseo 插件入口始终保留在仓库根目录的 `index.ts`。

Feature 目录中的文件使用简短的职责命名：

- `client.tsx`：React Native/Paseo 客户端 UI 和交互逻辑。
- `server.ts`：守护进程侧的 Node.js 逻辑，包括本地文件访问和 RPC 处理函数。
- `shared.ts`：客户端与服务端共用的 RPC 契约、Zod schema 和类型。

这些文件名不要重复 Feature 名称。例如使用 `features/prompt-templates/client.tsx`，不要使用 `features/prompt-templates/prompt-templates.client.tsx`。

保持依赖方向清晰：

- `client.tsx` 可以依赖 `shared.ts`，但不能导入 Node.js 模块或服务端实现。
- `server.ts` 可以依赖 `shared.ts` 以及 Feature 内的 service/repository 模块，但不能导入 React Native UI。
- `shared.ts` 不能依赖客户端或服务端实现。
- `components/` 只放跨 Feature 复用的组件；Feature 专属 UI 应放在对应 Feature 目录内。

只有当 Feature 的业务逻辑或持久化复杂到确实需要时，才增加 `service.ts`、`repository.ts` 等额外分层文件。
