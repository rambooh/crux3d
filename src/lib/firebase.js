import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut
} from 'firebase/auth';

// ⬇️ HIER dein firebaseConfig aus der Firebase Console einfügen
const firebaseConfig = {
  apiKey:        "YOUR_API_KEY",
  authDomain:    "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:     "YOUR_PROJECT_ID",
  appId:         "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export function initAuthStore(store) {
  onAuthStateChanged(auth, (u) => store.set(u));
}

export const login    = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export const register = (email, pw) => createUserWithEmailAndPassword(auth, email, pw);
export const logout   = () => signOut(auth);
