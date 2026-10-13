import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { CircleAlert, RotateCw } from 'lucide-react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Keeps unexpected render failures on the same site instead of leaving a blank view. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('파일핏 화면 오류', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="app-shell">
      <header className="topbar"><span className="brand">파일핏<span className="brand-dot">.</span></span></header>
      <main className="workbench recovery-workbench">
        <section className="operation-error" role="alert">
          <div className="operation-error-header"><div><span className="status-pill error"><CircleAlert size={14} /> 화면 복구 필요</span><h1>화면 표시가 중단됐어요</h1></div></div>
          <p className="operation-error-detail"><strong>실패한 이유</strong><br />{this.state.error.message || '예상하지 못한 화면 오류가 발생했습니다.'}</p>
          <p>같은 화면에서 다시 시도할 수 있습니다. 문제가 반복되면 파일을 다시 선택해 주세요.</p>
          <div className="operation-error-actions"><button className="button button-primary" onClick={() => this.setState({ error: null })}><RotateCw size={16} /> 화면 다시 표시</button></div>
        </section>
      </main>
    </div>;
  }
}
