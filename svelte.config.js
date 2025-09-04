import adapter from '@sveltejs/adapter-static';

const config = {
  kit: {
    adapter: adapter(),            // statischer Export (Netlify: super simpel)
    alias: { $lib: 'src/lib' }
  }
};
export default config;
