import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import PinGate from './PinGate'

createRoot(document.getElementById('root')!).render(
  <PinGate>
    <App />
  </PinGate>
)
