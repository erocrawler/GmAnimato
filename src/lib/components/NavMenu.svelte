<script lang="ts">
	import { page } from '$app/stores';
	
	interface Props {
		user: any;
		isAdmin: boolean;
		orientation?: 'horizontal' | 'vertical';
		drawerToggle?: HTMLInputElement | null;
	}
	
	let { user, isAdmin, orientation = 'horizontal', drawerToggle }: Props = $props();
	
	function closeDrawer() {
		if (orientation === 'vertical' && drawerToggle) {
			drawerToggle.checked = false;
		}
	}
	
	const menuClass = orientation === 'horizontal' ? 'menu-horizontal' : '';
</script>

{#if user}
	<ul class="menu {menuClass} px-1">
		{#if orientation === 'vertical'}
			<li><a href="/" onclick={closeDrawer} class:active={$page.url.pathname === '/'}>Home</a></li>
		{/if}
		<li><a href="/new" onclick={closeDrawer} class:active={$page.url.pathname === '/new'}>Create</a></li>
		<li><a href="/videos" onclick={closeDrawer} class:active={$page.url.pathname === '/videos'}>My Videos</a></li>
		<li><a href="/gallery" onclick={closeDrawer} class:active={$page.url.pathname === '/gallery'}>Gallery</a></li>
		{#if isAdmin}
			<li><a href="/admin" onclick={closeDrawer} class:active={$page.url.pathname.startsWith('/admin')} class="text-primary font-semibold">Admin</a></li>
		{/if}
		<li><a href="/profile" onclick={closeDrawer} class:active={$page.url.pathname.startsWith('/profile')}>Profile</a></li>
		<li class:mt-auto={orientation === 'vertical'}>
			<form method="post" action="/api/logout">
				<button type="submit" onclick={closeDrawer} class:btn={orientation === 'vertical'} class:btn-outline={orientation === 'vertical'} class:btn-error={orientation === 'vertical'} class:btn-sm={orientation === 'vertical'}>Logout</button>
			</form>
		</li>
	</ul>
{:else}
	<ul class="menu {menuClass} px-1">
		<li><a href="/" onclick={closeDrawer} class:active={$page.url.pathname === '/'}>Home</a></li>
		<li><a href="/gallery" onclick={closeDrawer} class:active={$page.url.pathname === '/gallery'}>Gallery</a></li>
		<li class:mt-auto={orientation === 'vertical'}>
			{#if orientation === 'vertical'}
				<a href="/login" onclick={closeDrawer} class="btn btn-primary btn-sm">Login</a>
			{:else}
				<a href="/login" class:active={$page.url.pathname === '/login'}>Login</a>
			{/if}
		</li>
	</ul>
{/if}

<style>
	.active {
		background-color: hsl(var(--b3));
	}
</style>
