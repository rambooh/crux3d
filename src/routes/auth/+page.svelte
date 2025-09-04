<script>
  import { login, register } from '$lib/firebase';
  let email = '';
  let password = '';
  let mode = 'login'; // 'login' | 'register'
  let error = '';

  async function submit(e) {
    e.preventDefault();
    error = '';
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password);
      }
      window.location.href = '/';
    } catch (e) {
      error = e?.message ?? String(e);
    }
  }
</script>

<section style="max-width:420px;margin:2rem auto;padding:1rem;border:1px solid #eee;border-radius:12px;">
  <h2 style="margin-top:0;">{mode === 'login' ? 'Login' : 'Register'}</h2>

  {#if error}
    <p style="color:#c00;">{error}</p>
  {/if}

  <form on:submit={submit} style="display:grid;gap:0.75rem;">
    <label>
      <div>E-Mail</div>
      <input type="email" bind:value={email} required />
    </label>
    <label>
      <div>Passwort</div>
      <input type="password" bind:value={password} minlength="6" required />
    </label>
    <button type="submit">{mode === 'login' ? 'Einloggen' : 'Registrieren'}</button>
  </form>

  <div style="margin-top:0.75rem;">
    {#if mode === 'login'}
      <a href="#" on:click={(e)=>{e.preventDefault(); mode='register';}}>Neu hier? Jetzt registrieren</a>
    {:else}
      <a href="#" on:click={(e)=>{e.preventDefault(); mode='login';}}>Schon Account? Zum Login</a>
    {/if}
  </div>
</section>
