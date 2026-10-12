import { afterEach, describe, expect, it } from 'vitest'
import { installOverlayMethods } from '../../app/testing/page'
import { qs } from '../../dom'
import { createListenBar } from './index'
import { createFakeSession } from './testing/fake-session'

afterEach(() => {
    document.body.innerHTML = ''
})

describe('createListenBar', () => {
    // jsdom has no speech synthesis, as a browser with no speech support.
    it('shows that the browser has no voices, and stops with the close button', async () => {
        installOverlayMethods()
        document.body.innerHTML = '<div id="dock"></div><div id="host"></div>'
        const session = createFakeSession({ chapters: ['One.'] })
        let exits = 0
        const bar = createListenBar({
            session,
            dock: qs('#dock'),
            host: qs('#host'),
            onExit: () => {
                exits += 1
            },
        })

        expect(bar.active).toBe(false)
        await bar.start()
        expect(bar.active).toBe(true)
        expect(session.mode).toBe('listen')
        expect(qs('.listen-bar').dataset.state).toBe('unavailable')
        expect(qs('.listen-message').textContent).toBe('This browser has no speech voices.')

        qs('[data-action="close"]').click()
        expect(bar.active).toBe(false)
        expect(session.mode).toBe('read')
        expect(exits).toBe(1)
        expect(document.querySelector('.listen-bar')).toBeNull()
        bar.destroy()
    })
})
