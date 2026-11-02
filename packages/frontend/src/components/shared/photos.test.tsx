import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coverCrop, outputSize } from '@/lib/photo'
import { Avatar, initialsOf, toneOf, VehiclePhoto } from './Avatar'
import { PhotoUploader } from './PhotoUploader'

// Photos of people and vehicles (docs/photos.md): the placeholders, the uploader, and the crop. jsdom cannot decode
// images, so preparePhoto is faked; its arithmetic (coverCrop, outputSize) is tested directly.

const prepared = vi.hoisted(() => ({ fail: null as Error | null }))
vi.mock('@/lib/photo', async (original) => {
  const real = await original<typeof import('@/lib/photo')>()
  return {
    ...real,
    preparePhoto: async (file: File) => {
      if (prepared.fail) throw prepared.fail
      return new Blob([file.name], { type: 'image/jpeg' })
    },
  }
})

beforeEach(() => {
  prepared.fail = null
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})

describe('placeholders', () => {
  it('a person without a photo is their initials, on a colour that is always theirs', () => {
    expect(initialsOf('Sara Bekele Alemu')).toBe('SA')
    expect(initialsOf('Abebe')).toBe('A')
    expect(initialsOf('  ')).toBe('?')
    expect(toneOf('Sara Bekele')).toBe(toneOf('Sara Bekele'))
    const { container } = render(<Avatar name="Sara Bekele" />)
    expect(container.textContent).toBe('SB')
    expect(container.querySelector('img')).toBeNull()
  })

  it('a photo that will not load falls back to the initials', () => {
    const { container } = render(<Avatar name="Sara Bekele" src="/api/v1/users/u/photo?v=1" label="Sara Bekele" />)
    const img = container.querySelector('img')!
    expect(screen.getByRole('img', { name: 'Sara Bekele' })).toHaveAttribute('data-photo', 'true')
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('SB')
  })

  it('a vehicle without a photo is its type’s icon', () => {
    const { container, rerender } = render(<VehiclePhoto vehicleType="bus" />)
    expect(container.querySelector('svg')).toHaveClass('lucide-bus')
    rerender(<VehiclePhoto vehicleType="other" />)
    expect(container.querySelector('svg')).toHaveClass('lucide-truck')
    rerender(<VehiclePhoto vehicleType="bus" src="/api/v1/vehicles/v/photo?v=2" />)
    expect(container.querySelector('img')).toHaveAttribute('src', '/api/v1/vehicles/v/photo?v=2')
  })
})

describe('PhotoUploader', () => {
  function setup(current: string | null = null) {
    const upload = vi.fn(async (form: FormData) => {
      expect(form.get('file')).toBeInstanceOf(Blob)
      return { photo_url: '/api/v1/users/u/photo?v=9' }
    })
    const remove = vi.fn(async () => undefined)
    const onChange = vi.fn()
    render(
      <PhotoUploader
        subject="Sara Bekele"
        shape="portrait"
        current={current}
        renderPreview={(src) => <Avatar name="Sara Bekele" src={src} size="lg" label="Preview" />}
        upload={upload}
        remove={remove}
        onChange={onChange}
      />,
    )
    return { upload, remove, onChange, user: userEvent.setup() }
  }

  it('uploads a chosen picture and shows the new photo', async () => {
    const { upload, onChange, user } = setup()
    expect(screen.getByRole('button', { name: 'Add a photo of Sara Bekele' })).toBeInTheDocument()
    await user.upload(screen.getByTestId('photo-file'), new File(['x'], 'me.png', { type: 'image/png' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/api/v1/users/u/photo?v=9'))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Change the photo of Sara Bekele' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeInTheDocument()
  })

  it('removes the photo', async () => {
    const { remove, onChange, user } = setup('/api/v1/users/u/photo?v=1')
    await user.click(screen.getByRole('button', { name: 'Remove the photo of Sara Bekele' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeInTheDocument()
  })

  it('says why a picture was refused, and keeps the photo it had when the upload fails', async () => {
    const { PhotoRejected } = await import('@/lib/photo')
    const { upload, onChange, user } = setup('/api/v1/users/u/photo?v=1')
    prepared.fail = new PhotoRejected('type')
    await user.upload(screen.getByTestId('photo-file'), new File(['x'], 'a.gif', { type: 'image/png' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a JPEG, PNG or WebP picture.')
    expect(upload).not.toHaveBeenCalled()

    prepared.fail = null
    upload.mockRejectedValueOnce(new Error('The server could not be reached.'))
    await user.upload(screen.getByTestId('photo-file'), new File(['x'], 'b.png', { type: 'image/png' }))
    expect(await screen.findByText('The server could not be reached.')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('img', { name: 'Preview' }).querySelector('img')).toHaveAttribute('src', '/api/v1/users/u/photo?v=1')
  })
})

describe('crop and shrink', () => {
  it('crops the middle that fills the frame', () => {
    // A 4000 x 3000 landscape into a square: the centre 3000 x 3000.
    expect(coverCrop(4000, 3000, 512, 512)).toEqual({ sx: 500, sy: 0, sWidth: 3000, sHeight: 3000 })
    // A portrait phone picture into 4:3: the middle band.
    expect(coverCrop(3000, 4000, 1280, 960)).toEqual({ sx: 0, sy: 875, sWidth: 3000, sHeight: 2250 })
  })

  it('never enlarges a small picture', () => {
    expect(outputSize('portrait', 4000, 3000)).toEqual({ width: 512, height: 512 })
    expect(outputSize('portrait', 300, 200)).toEqual({ width: 200, height: 200 })
    expect(outputSize('vehicle', 640, 960)).toEqual({ width: 640, height: 480 })
  })
})
