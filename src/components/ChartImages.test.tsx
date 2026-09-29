/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChartImages } from './ChartImages'
import { useChartImages } from '@/state/weatherFiles'

afterEach(() => {
  cleanup()
  act(() => useChartImages.setState({ images: [] }))
})

describe('chart images', () => {
  it('places an image by two control points', () => {
    URL.createObjectURL = (() => 'blob:chart') as typeof URL.createObjectURL
    act(() => void useChartImages.getState().addImage(new File([new Uint8Array(4)], 'chart.png'), { west: -75, south: 38, east: -60, north: 48 }))
    render(<ChartImages area={{ west: -75, south: 38, east: -60, north: 48 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'POINTS' }))
    const pic = screen.getByAltText(/chart.png: tap a point/) as HTMLImageElement
    Object.defineProperty(pic, 'naturalWidth', { value: 400 })
    Object.defineProperty(pic, 'naturalHeight', { value: 300 })
    fireEvent.load(pic)
    const type = (label: string, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } })
    fireEvent.click(screen.getByRole('button', { name: 'ADD POINT' }))
    fireEvent.click(screen.getByRole('button', { name: 'ADD POINT' }))
    // A latitude/longitude picture: 50°N 80°W at the top-left, 35°N 60°W at the middle.
    type('Point 1 x', '0')
    type('Point 1 y', '0')
    type('Point 1 lat', '50')
    type('Point 1 lon', '-80')
    type('Point 2 x', '200')
    type('Point 2 y', '150')
    type('Point 2 lat', '35')
    type('Point 2 lon', '-60')
    fireEvent.change(screen.getByLabelText('Picture projection'), { target: { value: 'latlon' } })
    fireEvent.click(screen.getByRole('button', { name: 'PLACE' }))
    expect(useChartImages.getState().images[0].bbox).toEqual({ west: -80, east: -40, north: 50, south: 20 })
    expect(screen.getByText('Placed: the points fit to 0.0 px.')).toBeTruthy()
    // The edges show what the points set.
    expect((screen.getByLabelText('Right °') as HTMLInputElement).value).toBe('-40')
  })

  it('says when the points do not place the picture', () => {
    URL.createObjectURL = (() => 'blob:chart') as typeof URL.createObjectURL
    act(() => void useChartImages.getState().addImage(new File([new Uint8Array(4)], 'fax.png'), { west: -75, south: 38, east: -60, north: 48 }))
    render(<ChartImages area={{ west: -75, south: 38, east: -60, north: 48 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'POINTS' }))
    fireEvent.click(screen.getByRole('button', { name: 'ADD POINT' }))
    fireEvent.click(screen.getByRole('button', { name: 'ADD POINT' }))
    fireEvent.click(screen.getByRole('button', { name: 'PLACE' }))
    expect(screen.getByText(/Needs two points or more/)).toBeTruthy()
    expect(useChartImages.getState().images[0].bbox.west).toBe(-75)
  })
})
