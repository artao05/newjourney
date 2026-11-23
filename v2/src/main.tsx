import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startLoop } from './state'
import './styles.css'

document.documentElement.dataset.theme = 'night'
startLoop()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
