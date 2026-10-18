import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { currentUser, renderApp, signedInAs } from '@/test/auth'

// FMS-114 end to end through the router, with the seeded permissions of each role.
const dispatcher = currentUser(
  ['dispatcher'],
  ['alert:ack', 'alert:read', 'alert:resolve', 'analytics:read', 'assignment:read', 'assignment:write', 'attendance:read', 'command:read', 'depot:read', 'driver:read', 'incident:read', 'notification:read', 'route:read', 'route:write', 'tracking:read', 'trip:assign', 'trip:execute', 'trip:read', 'trip:write', 'vehicle:read'],
)
const driver = currentUser(['driver'], ['attendance:read', 'attendance:write', 'document:write', 'dvir:read', 'dvir:write', 'fuel:read', 'fuel:write', 'incident:write', 'notification:read', 'route:read', 'trip:execute', 'trip:read', 'vehicle:read'])
const technician = currentUser(['technician'], ['alert:read', 'depot:read', 'document:read', 'document:write', 'dvir:read', 'dvir:write', 'incident:read', 'incident:write', 'inventory:read', 'inventory:write', 'maintenance:execute', 'maintenance:read', 'maintenance:write', 'notification:read', 'prediction:read', 'vehicle:read'])

const location = () => screen.getByTestId('location').textContent
const mainMenu = () => screen.getAllByRole('navigation', { name: 'Main' })[0]

describe('portals', () => {
  it('a dispatcher lands on /dispatch, with a menu grouped by portal that holds only what they may open', async () => {
    signedInAs(dispatcher)
    renderApp('/')
    await waitFor(() => expect(location()).toBe('/dispatch'))
    expect(await screen.findByRole('heading', { name: 'Dispatch' })).toBeInTheDocument()

    const menu = mainMenu()
    expect(within(menu).getAllByRole('heading').map((h) => h.textContent)).toEqual(['Fleet management', 'Command center'])
    expect(within(menu).getAllByRole('link').map((a) => a.textContent)).toEqual(['Dashboard', 'Vehicles', 'Drivers', 'Attendance', 'Routes', 'DispatchSoon', 'Live mapSoon'])
    // "Soon" is decoration: the links keep their plain names for assistive technology.
    expect(within(menu).getByRole('link', { name: 'Live map' })).toBeInTheDocument()
    // Not the driver's portal, though dispatchers hold trip:execute.
    expect(within(menu).queryByRole('link', { name: 'My day' })).not.toBeInTheDocument()
    expect(within(menu).getByRole('link', { name: 'Dispatch' })).toHaveAttribute('aria-current', 'page')
  })

  it('a driver lands on /driver in the mobile driver portal: no staff menu, account sheet with sign out', async () => {
    signedInAs(driver)
    renderApp('/')
    await waitFor(() => expect(location()).toBe('/driver'))
    expect(await screen.findByRole('heading', { name: 'Driver Home' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Vehicles' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Fleet management' })).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Account' }))
    const sheet = await screen.findByRole('dialog', { name: 'Account' })
    expect(within(sheet).getByText('Sam Tester')).toBeInTheDocument()
    expect(within(sheet).getAllByRole('link').map((a) => a.textContent)).toEqual(['My day'])
    expect(within(sheet).getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('a technician lands on the repair log', async () => {
    signedInAs(technician)
    renderApp('/')
    await waitFor(() => expect(location()).toBe('/maintenance'))
  })

  it('a staff screen opened by a driver by URL still shows nothing (routes stay protected)', async () => {
    signedInAs(driver)
    renderApp('/dispatch')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
  })
})

describe('top bar', () => {
  it('the notification bell opens a panel and closes on Escape, returning focus', async () => {
    signedInAs(dispatcher)
    renderApp('/dispatch')
    const user = userEvent.setup()
    const bell = await screen.findByRole('button', { name: 'Notifications' })
    expect(bell).toHaveAttribute('aria-expanded', 'false')
    await user.click(bell)
    expect(bell).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('heading', { name: 'Notifications' })).toHaveFocus()
    expect(screen.getByText("You're all caught up")).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument()
    expect(bell).toHaveFocus()
  })

  it('names the page as well as the portal', async () => {
    signedInAs(dispatcher)
    renderApp('/dispatch')
    const header = (await screen.findAllByRole('banner'))[0]
    expect(within(header).getByText('Command center')).toBeInTheDocument()
    expect(within(header).getByText('Dispatch')).toBeInTheDocument()
  })

  it('names the current portal', async () => {
    signedInAs(dispatcher)
    renderApp('/vehicles')
    const header = (await screen.findAllByRole('banner'))[0]
    expect(within(header).getByText('Fleet management')).toBeInTheDocument()
  })

  it('staff and driver top bars both carry the theme toggle', async () => {
    const user = userEvent.setup()
    signedInAs(dispatcher)
    const staff = renderApp('/dispatch')
    await user.click(await screen.findByRole('button', { name: /Switch to (dark|light) theme/ }))
    expect(document.documentElement.getAttribute('data-theme')).toMatch(/light|dark/)
    staff.unmount()

    signedInAs(driver)
    renderApp('/')
    expect(await screen.findByRole('button', { name: /Switch to (dark|light) theme/ })).toBeInTheDocument()
  })
})

describe('sidebar', () => {
  it('collapses to an icon rail, keeps every link reachable by name, and remembers the choice', async () => {
    localStorage.removeItem('fms-sidebar')
    signedInAs(dispatcher)
    renderApp('/dispatch')
    const user = userEvent.setup()
    const toggle = await screen.findByRole('button', { name: 'Collapse sidebar' })
    const aside = toggle.closest('aside')!
    expect(aside).toHaveAttribute('data-collapsed', 'false')

    await user.click(toggle)
    expect(aside).toHaveAttribute('data-collapsed', 'true')
    expect(localStorage.getItem('fms-sidebar')).toBe('collapsed')
    expect(within(aside).getByRole('link', { name: 'Vehicles' })).toBeInTheDocument()

    await user.click(within(aside).getByRole('button', { name: 'Expand sidebar' }))
    expect(aside).toHaveAttribute('data-collapsed', 'false')
    expect(localStorage.getItem('fms-sidebar')).toBe('expanded')
  })

  it('shows the signed-in role under the name', async () => {
    signedInAs(dispatcher)
    renderApp('/dispatch')
    const aside = (await screen.findByRole('button', { name: /sidebar/ })).closest('aside')!
    expect(within(aside).getByText('Dispatcher')).toBeInTheDocument()
  })
})

describe('help and calendar', () => {
  it('? opens the help; the Ethiopian calendar choice is remembered', async () => {
    localStorage.clear()
    signedInAs(dispatcher)
    renderApp('/dispatch')
    await screen.findByRole('heading', { name: 'Dispatch' })
    const user = userEvent.setup()
    await user.keyboard('?')
    const help = await screen.findByRole('dialog', { name: 'Help' })
    expect(within(help).getByText('Ready to dispatch')).toBeInTheDocument()
    expect(within(help).getByText('Jump to the search box')).toBeInTheDocument()
    await user.click(within(help).getByRole('radio', { name: 'Ethiopian' }))
    expect(localStorage.getItem('fms-calendar')).toBe('"ethiopic"')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Help' })).not.toBeInTheDocument()
  })

  it('the help button in the top bar opens the same dialog', async () => {
    signedInAs(dispatcher)
    renderApp('/dispatch')
    await userEvent.click(await screen.findByRole('button', { name: 'Help and shortcuts' }))
    expect(await screen.findByRole('dialog', { name: 'Help' })).toBeInTheDocument()
  })

  it('the menu button sits before the page name on small screens', async () => {
    signedInAs(dispatcher)
    renderApp('/dispatch')
    const menu = await screen.findByRole('button', { name: 'Open menu' })
    const help = screen.getByRole('button', { name: 'Help and shortcuts' })
    expect(menu.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
