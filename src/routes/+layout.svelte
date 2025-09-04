<script>
  import { onMount } from 'svelte';
  import { user } from '$lib/authStore';
  import { initAuthStore, logout } from '$lib/firebase';

  onMount(() => initAuthStore(user));
</script>

<nav style="display:flex;gap:1rem;align-items:center;padding:0.75rem 1rem;border-bottom:1px solid #eee;">
  <a href="/">crux3d</a>
  <a href="/auth">Login</a>
  <div style="margin-left:auto;display:flex;gap:0.75rem;align-items:center;">
    {#if $user}
      <span style="font-size:0.9rem;color:#666;">{$user.email}</span>
      <button on:click={logout}>Logout</button>
    {:else}
      <a href="/auth"><button>Register / Login</button></a>
    {/if}
  </div>
</nav>

<slot />
