import { describe, expect, test } from 'bun:test'
import { normalizeDeviceSnapshot } from './devices'

describe('normalizeDeviceSnapshot', () => {
  test('reads the helper listing', () => {
    expect(
      normalizeDeviceSnapshot({
        '2': {
          index: 2,
          name: 'Wireless Mic Rx',
          id: 'AppleUSBAudioEngine:DJI:1',
          transport: 'usb',
          isDefault: false,
        },
        '4': {
          index: 4,
          name: 'AirPods Pro',
          id: 'B0-3F:input',
          transport: 'bluetooth',
          isDefault: true,
        },
      })
    ).toEqual({
      devices: { '2': 'Wireless Mic Rx', '4': 'AirPods Pro' },
      details: {
        '2': {
          index: 2,
          name: 'Wireless Mic Rx',
          id: 'AppleUSBAudioEngine:DJI:1',
          transport: 'usb',
          isDefault: false,
        },
        '4': {
          index: 4,
          name: 'AirPods Pro',
          id: 'B0-3F:input',
          transport: 'bluetooth',
          isDefault: true,
        },
      },
    })
  })

  test('an unknown transport is other, a missing id is null', () => {
    expect(
      normalizeDeviceSnapshot({
        '0': { name: 'Mic', transport: 'thunderbolt' },
      }).details['0']
    ).toEqual({
      index: 0,
      name: 'Mic',
      id: null,
      transport: 'other',
      isDefault: false,
    })
  })

  test('skips entries without a name and anything that is not an object', () => {
    expect(
      normalizeDeviceSnapshot({ '0': 'Old format', '1': { id: 'x' }, a: {} })
    ).toEqual({ devices: {}, details: {} })
    expect(normalizeDeviceSnapshot([])).toEqual({ devices: {}, details: {} })
  })
})
