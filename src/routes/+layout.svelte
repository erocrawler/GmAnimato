<script lang="ts">
	import '../app.css';
	import NavMenu from '$lib/components/NavMenu.svelte';
	
	let { children, data }: { children: any; data: any } = $props();
	
	const isAdmin = $derived(data?.user?.roles?.includes('admin') || false);
</script>

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
				<a href="/" class="btn btn-ghost text-xl">
					<img src="/apple-touch-icon.png" alt="GmAnimato" class="w-8 h-8" />
					GmAnimato
				</a>
			</div>
		<div class="flex-none hidden lg:block">
			<NavMenu user={data?.user} {isAdmin} orientation="horizontal" />
		</div>
	</div>		<!-- Page content -->
		<main class="flex-grow container mx-auto p-4 lg:p-8">
			{@render children()}
		</main>

		<!-- Footer -->
		<footer class="footer footer-center p-4 bg-base-200 text-base-content">
			<aside>
				<p>GmAnimato — Image-to-Video Generator © 2025</p>
			</aside>
		</footer>
	</div>
	
	<!-- Drawer sidebar -->
	<div class="drawer-side">
		<label for="main-drawer" aria-label="close sidebar" class="drawer-overlay"></label>
		<div class="w-80 min-h-full bg-base-200 p-4">
			<NavMenu user={data?.user} {isAdmin} orientation="vertical" />
		</div>
	</div>
</div>
