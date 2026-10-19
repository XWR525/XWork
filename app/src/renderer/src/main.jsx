import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import 'katex/dist/katex.min.css'

// 兜底：渲染期异常（例如 TDZ / 空引用）默认会让整个窗口**全白且没有任何线索**，
// 用户只能看到"界面打不开"。2026-10-19 就因 `viewMessages` 在声明前被依赖数组引用而白屏过一次。
// 这里把错误直接摊在页面上（含前 30 行 stack），并给一个「重新加载」按钮。
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    // 同时打到控制台，便于用 DevTools / 主进程日志取证
    console.error('[renderer] 界面渲染异常:', error, info && info.componentStack)
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const stack = String((error && error.stack) || error || '')
    return (
      <div
        style={{
          padding: 24,
          height: '100vh',
          overflow: 'auto',
          background: '#1b1d21',
          color: '#e6e6e6',
          fontFamily: 'Consolas, ui-monospace, monospace',
          fontSize: 12.5,
          lineHeight: 1.5
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, color: '#ff7b72' }}>
          界面渲染失败（已拦截，避免全白）
        </div>
        <div style={{ marginBottom: 10 }}>{String((error && error.message) || error)}</div>
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, opacity: 0.85 }}>
          {stack.split('\n').slice(0, 30).join('\n')}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{ marginTop: 14, padding: '4px 14px', cursor: 'pointer' }}
        >
          重新加载
        </button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
