import { root } from '../lib/root.js'
import { PartyApp } from '../party-app.js'

export default root.lets
  .page('/')
  .head({ title: 'agents-party' })
  .page(() => <PartyApp />)
