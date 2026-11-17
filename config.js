// Address of the Secure Notes backend. Local development uses the API on port 3000;
// the deployed site uses the hosted API.
window.API_URL = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:3000'
  : 'https://REPLACE-WITH-BACKEND.onrender.com';
