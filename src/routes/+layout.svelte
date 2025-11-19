<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';
	import { page } from '$app/stores';
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="drawer">
	<input id="main-drawer" type="checkbox" class="drawer-toggle" />
	<div class="drawer-content flex flex-col">
		<!-- Navbar -->
		<div class="navbar bg-base-200 shadow-lg">
			<div class="flex-none lg:hidden">
				<label for="main-drawer" aria-label="open sidebar" class="btn btn-square btn-ghost">
					<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-6 h-6 stroke-current">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
					</svg>
				</label>
			</div>
			<div class="flex-1">
				<a href="/" class="btn btn-ghost text-xl">🎬 GmI2V</a>
			</div>
			<div class="flex-none hidden lg:block">
				<ul class="menu menu-horizontal px-1">
					<li><a href="/new" class:active={$page.url.pathname === '/new'}>Create</a></li>
					<li><a href="/videos" class:active={$page.url.pathname === '/videos'}>My Videos</a></li>
					<li><a href="/gallery" class:active={$page.url.pathname === '/gallery'}>Gallery</a></li>
					<li>
						<form method="post" action="/api/logout">
							<button type="submit">Logout</button>
						</form>
					</li>
				</ul>
			</div>
		</div>
		
		<!-- Page content -->
		<main class="flex-grow container mx-auto p-4 lg:p-8">
			{@render children()}
		</main>

		<!-- Footer -->
		<footer class="footer footer-center p-4 bg-base-200 text-base-content">
			<aside>
				<p>GmI2V — Image-to-Video Generator © 2024</p>
			</aside>
		</footer>
	</div>
	
	<!-- Drawer sidebar -->
	<div class="drawer-side">
		<label for="main-drawer" aria-label="close sidebar" class="drawer-overlay"></label>
		<ul class="menu p-4 w-80 min-h-full bg-base-200">
			<li><a href="/" class:active={$page.url.pathname === '/'}>Home</a></li>
			<li><a href="/new" class:active={$page.url.pathname === '/new'}>Create</a></li>
			<li><a href="/videos" class:active={$page.url.pathname === '/videos'}>My Videos</a></li>
			<li><a href="/gallery" class:active={$page.url.pathname === '/gallery'}>Gallery</a></li>
			<li class="mt-auto">
				<form method="post" action="/api/logout">
					<button type="submit" class="btn btn-outline btn-error btn-sm">Logout</button>
				</form>
			</li>
		</ul>
	</div>
</div>

<style>
	.active {
		background-color: hsl(var(--b3));
	}
</style>
