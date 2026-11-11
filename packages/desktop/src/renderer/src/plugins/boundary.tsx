import { Component, type ReactNode } from 'react'
import type { PluginErrorReporter, PluginView } from './types'
import './boundary.css'

/**
 * The view's own output, one component below the boundary: React hands an error to the nearest
 * boundary *above* the component that threw, so the boundary can never render the view itself.
 */
function PluginViewBody({ render }: { render: () => ReactNode }) {
  return <>{render()}</>
}

function FallbackPanel({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div className="plugin-error" data-testid="plugin-error" role="alert">
      <h2 className="plugin-error-title">{title} stopped working</h2>
      <p className="plugin-error-help">This panel hit an error. Slate and the other tools are unaffected.</p>
      <button type="button" className="btn plugin-error-retry" data-testid="plugin-error-retry" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

interface Props {
  pluginId: string
  title: string
  render: () => ReactNode
  onError: PluginErrorReporter
}

interface State {
  /** Bumped by Try again, so the body is built from scratch rather than re-shown broken. */
  attempt: number
  failed: boolean
}

class PluginViewBoundary extends Component<Props, State> {
  override state: State = { attempt: 0, failed: false }

  static getDerivedStateFromError(): Pick<State, 'failed'> {
    return { failed: true }
  }

  override componentDidCatch(error: Error): void {
    this.props.onError(`${this.props.pluginId} view "${this.props.title}" failed to render`, error)
  }

  override render(): ReactNode {
    if (this.state.failed) return <FallbackPanel title={this.props.title} onRetry={() => this.setState((s) => ({ attempt: s.attempt + 1, failed: false }))} />
    return <PluginViewBody key={this.state.attempt} render={this.props.render} />
  }
}

/** The same view, drawn inside a boundary: a throwing panel shows the fallback and the others keep working. */
export function withErrorBoundary(pluginId: string, view: PluginView, onError: PluginErrorReporter): PluginView {
  return { ...view, render: () => <PluginViewBoundary pluginId={pluginId} title={view.title} render={view.render} onError={onError} /> }
}
