const API_KEY = "1d3ae144acfb6bfcb25f70361cedcf29";
const BASE_URL = "https://api.themoviedb.org/3";
const IMG_URL = "https://image.tmdb.org/t/p/w500";

// LOAD ROWS
fetchMovies(`${BASE_URL}/trending/movie/week?api_key=${API_KEY}`, "trending");
fetchMovies(`${BASE_URL}/discover/movie?api_key=${API_KEY}&with_genres=28`, "action");
fetchMovies(`${BASE_URL}/discover/movie?api_key=${API_KEY}&with_genres=35`, "comedy");
fetchMovies(`${BASE_URL}/movie/top_rated?api_key=${API_KEY}`, "toprated");

function fetchMovies(url, containerId) {
  fetch(url)
    .then(res => res.json())
    .then(data => displayMovies(data.results, containerId));
}

// DISPLAY MOVIES
function displayMovies(movies, containerId) {
  const container = document.getElementById(containerId);

  movies.forEach(movie => {
    if (!movie.poster_path) return;

    const card = document.createElement("div");
    card.classList.add("movie-card");

    const img = document.createElement("img");
    img.src = IMG_URL + movie.poster_path;

    const info = document.createElement("div");
    info.classList.add("movie-info");
    info.innerHTML = `
      <strong>${movie.title}</strong><br>
      ⭐ ${movie.vote_average}
    `;

    card.appendChild(img);
    card.appendChild(info);

    card.onclick = () => getTrailer(movie.id);

    container.appendChild(card);
  });
}

// TRAILER
function getTrailer(movieId) {
  fetch(`${BASE_URL}/movie/${movieId}/videos?api_key=${API_KEY}`)
    .then(res => res.json())
    .then(data => {
      const trailer = data.results.find(v => v.type === "Trailer");

      if (trailer) {
        openPlayer(trailer.key);
      } else {
        alert("No trailer available");
      }
    });
}

function openPlayer(key) {
  document.getElementById("videoFrame").src = `https://www.youtube.com/embed/${key}`;
  document.getElementById("player").style.display = "flex";
}

function closePlayer() {
  document.getElementById("videoFrame").src = "";
  document.getElementById("player").style.display = "none";
}

// SEARCH
let timeout;

function debounceSearch(query) {
  clearTimeout(timeout);
  timeout = setTimeout(() => {
    searchMovies(query);
  }, 500);
}

function searchMovies(query) {
  const container = document.getElementById("searchResults");

  if (query.length < 3) {
    container.innerHTML = "";
    return;
  }

  fetch(`${BASE_URL}/search/movie?api_key=${API_KEY}&query=${query}`)
    .then(res => res.json())
    .then(data => displaySearchResults(data.results));
}

function displaySearchResults(movies) {
  const container = document.getElementById("searchResults");
  container.innerHTML = "<h2>Search Results</h2><div class='movies'></div>";

  const moviesDiv = container.querySelector(".movies");

  movies.forEach(movie => {
    if (!movie.poster_path) return;

    const card = document.createElement("div");
    card.classList.add("movie-card");

    const img = document.createElement("img");
    img.src = IMG_URL + movie.poster_path;

    const info = document.createElement("div");
    info.classList.add("movie-info");
    info.innerHTML = `
      <strong>${movie.title}</strong><br>
      ⭐ ${movie.vote_average}
    `;

    card.appendChild(img);
    card.appendChild(info);

    card.onclick = () => getTrailer(movie.id);

    moviesDiv.appendChild(card);
  });
}
