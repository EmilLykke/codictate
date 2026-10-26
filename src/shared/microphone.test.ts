import { describe, expect, test } from 'bun:test'
import {
  microphoneDeviceRef,
  resolveMicrophone,
  type MicrophoneDevice,
} from './microphone'

const device = (
  index: number,
  name: string,
  transport: MicrophoneDevice['transport'],
  extra: Partial<MicrophoneDevice> = {}
): MicrophoneDevice => ({
  index,
  name,
  id: `uid-${name}`,
  transport,
  isDefault: false,
  ...extra,
})

const blackHole = device(0, 'BlackHole 2ch', 'virtual')
const builtIn = device(1, 'MacBook Pro Microphone', 'built-in')
const dji = device(2, 'Wireless Mic Rx', 'usb')
const airPods = device(4, 'AirPods Pro', 'bluetooth', { isDefault: true })
const desk = [blackHole, builtIn, dji, airPods]

describe('resolveMicrophone', () => {
  test('uses the pick when it is connected, by id', () => {
    expect(
      resolveMicrophone({ id: 'uid-Wireless Mic Rx', name: 'renamed' }, desk)
    ).toEqual({ device: dji, isPick: true })
  })

  test('falls back to the name for a pick stored without an id', () => {
    expect(
      resolveMicrophone({ id: null, name: 'Wireless Mic Rx' }, desk)
    ).toEqual({ device: dji, isPick: true })
  })

  test('a missing pick records from the built-in microphone, never an index', () => {
    expect(
      resolveMicrophone({ id: null, name: 'Logitech StreamCam' }, desk)
    ).toEqual({ device: builtIn, isPick: false })
  })

  test('the pick comes back the moment it reconnects', () => {
    const pick = { id: 'uid-Wireless Mic Rx', name: 'Wireless Mic Rx' }
    expect(resolveMicrophone(pick, [blackHole, builtIn, airPods])?.device).toBe(
      builtIn
    )
    expect(resolveMicrophone(pick, desk)?.device).toBe(dji)
  })

  test('without a built-in microphone, any that is neither Bluetooth nor virtual', () => {
    expect(
      resolveMicrophone({ id: 'gone', name: null }, [blackHole, airPods, dji])
        ?.device
    ).toBe(dji)
  })

  test('then the system default, even over Bluetooth', () => {
    expect(
      resolveMicrophone({ id: 'gone', name: null }, [blackHole, airPods])
        ?.device
    ).toBe(airPods)
  })

  test('then whatever is there', () => {
    expect(
      resolveMicrophone({ id: 'gone', name: null }, [blackHole])?.device
    ).toBe(blackHole)
  })

  test('no microphone at all', () => {
    expect(resolveMicrophone({ id: null, name: null }, [])).toBeNull()
  })

  test('never picked is a fallback like any other', () => {
    expect(resolveMicrophone({ id: null, name: null }, desk)).toEqual({
      device: builtIn,
      isPick: false,
    })
  })
})

describe('microphoneDeviceRef', () => {
  test('prefers the stable id', () => {
    expect(microphoneDeviceRef(dji)).toBe('uid-Wireless Mic Rx')
    expect(microphoneDeviceRef({ ...dji, id: null })).toBe('2')
  })
})
