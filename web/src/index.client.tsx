import { mount } from '@point0/react-dom/mount'
import App from './app.client.js'
import points from './generated/point0/points.client.js'
import './styles/index.css'
import { applyStoredTheme } from './lib/theme.js'

applyStoredTheme()

mount(<App />, points)

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
if (import.meta.hot) {
  import.meta.hot.accept()
}
